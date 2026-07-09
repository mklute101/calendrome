import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { insertTimeEntry, listPendingReview } from '../src/time-entry.js';
import { getTimesheetSummary } from '../src/timesheet.js';
import { buildTools } from '../src/mcp/tools/index.js';

/**
 * Regression tests for #92: `get_timesheet_summary` dropped every entry
 * on the first day of a range whenever the caller passed `from` as a
 * full ISO timestamp, while `list_pending_review` returned them —
 * two read tools disagreeing about the same range on the same DB.
 *
 * Both now share the day-bucket normalization in `day-range.ts`, so
 * these tests pin the contract: identical range in → identical row
 * set out, regardless of bound format.
 */

function seed(db: any) {
  db.prepare(
    `INSERT INTO projects (id, name, prefix, category_id) VALUES ('WORK', 'Work', 'WORK', 'work')`,
  ).run();
}

// Entries deliberately have no task_id so the timesheet query groups
// one row per time_entry, making row counts comparable across tools.
function entry(
  db: any,
  startAt: string,
  status: 'CONFIRMED' | 'UNCONFIRMED',
  notes: string,
) {
  return insertTimeEntry(db, {
    project_id: 'WORK',
    start_at: startAt,
    end_at: startAt.replace(/T(\d{2})/, (_, h) => `T${String(Number(h) + 1).padStart(2, '0')}`),
    actual_minutes: 60,
    status,
    confirmed_at: status === 'CONFIRMED' ? startAt : null,
    source: status === 'CONFIRMED' ? 'manual' : 'placement',
    notes,
  });
}

describe('range parity between get_timesheet_summary and list_pending_review (#92)', () => {
  it('keeps first-day rows when from is a full ISO timestamp', () => {
    const db = freshDb();
    seed(db);
    entry(db, '2026-07-06T09:00:00Z', 'CONFIRMED', 'day1 confirmed');
    entry(db, '2026-07-06T11:00:00Z', 'UNCONFIRMED', 'day1 pending');
    entry(db, '2026-07-07T09:00:00Z', 'UNCONFIRMED', 'day2 pending');

    const summary = getTimesheetSummary(
      db,
      '2026-07-06T00:00:00Z',
      '2026-07-12T23:59:59Z',
      { include_unconfirmed: true },
    );

    expect(summary.rows.map((r) => r.date)).toEqual(['2026-07-06']);
    expect(summary.unconfirmed!.rows.map((r) => r.date)).toEqual([
      '2026-07-06',
      '2026-07-07',
    ]);
  });

  it('resolves the identical UNCONFIRMED row set as list_pending_review for the same range', () => {
    const db = freshDb();
    seed(db);
    entry(db, '2026-07-06T09:00:00Z', 'UNCONFIRMED', 'day1 a');
    entry(db, '2026-07-06T14:00:00Z', 'UNCONFIRMED', 'day1 b');
    entry(db, '2026-07-07T09:00:00Z', 'UNCONFIRMED', 'day2');
    entry(db, '2026-07-13T09:00:00Z', 'UNCONFIRMED', 'outside range');

    const from = '2026-07-06T00:00:00Z';
    const to = '2026-07-12T23:59:59Z';

    const pending = listPendingReview(db, { from, to });
    const summary = getTimesheetSummary(db, from, to, {
      include_unconfirmed: true,
    });

    expect(pending.map((r) => r.notes).sort()).toEqual([
      'day1 a',
      'day1 b',
      'day2',
    ]);
    expect(summary.unconfirmed!.rows.map((r) => r.task).sort()).toEqual([
      'day1 a',
      'day1 b',
      'day2',
    ]);
  });

  it('returns the same rows for plain-date and timestamp bounds', () => {
    const db = freshDb();
    seed(db);
    entry(db, '2026-07-06T09:00:00Z', 'CONFIRMED', 'day1');
    entry(db, '2026-07-08T09:00:00Z', 'CONFIRMED', 'day3');

    const plain = getTimesheetSummary(db, '2026-07-06', '2026-07-08');
    const stamped = getTimesheetSummary(
      db,
      '2026-07-06T00:00:00Z',
      '2026-07-08T23:59:59Z',
    );

    expect(stamped).toEqual(plain);
    expect(plain.rows).toHaveLength(2);
  });

  it('get_week_layout keeps first-day placements when from is a full ISO timestamp', async () => {
    const db = freshDb();
    seed(db);
    db.prepare(
      `INSERT INTO tasks (project_id, title, status) VALUES ('WORK', 'day1 task', 'PLACED')`,
    ).run();
    const taskId = db
      .prepare(`SELECT id FROM tasks WHERE title = 'day1 task'`)
      .get() as { id: number };
    insertTimeEntry(db, {
      task_id: taskId.id,
      project_id: 'WORK',
      start_at: '2026-07-06T09:00:00Z',
      end_at: '2026-07-06T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });

    const tools = buildTools(db);
    const layout = tools.find((t) => t.name === 'get_week_layout')!;
    const result = (await layout.handler({
      from: '2026-07-06T00:00:00Z',
      to: '2026-07-12T23:59:59Z',
    })) as { placements: { start_at: string }[] };

    expect(result.placements.map((p) => p.start_at)).toEqual([
      '2026-07-06T09:00:00Z',
    ]);
  });

  it('list_pending_review keeps last-day rows when to is a plain date', () => {
    // The mirror-image bug: the old `start_at < to` string compare
    // silently dropped the entire final day for plain-date bounds.
    const db = freshDb();
    seed(db);
    entry(db, '2026-07-08T09:00:00Z', 'UNCONFIRMED', 'last day');

    const rows = listPendingReview(db, { from: '2026-07-06', to: '2026-07-08' });
    expect(rows.map((r) => r.notes)).toEqual(['last day']);
  });
});
