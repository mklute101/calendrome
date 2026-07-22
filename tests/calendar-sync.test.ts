import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { syncCalendarEvents, listCalendarEvents } from '../src/calendar-sync.js';

describe('calendar-sync', () => {
  it('syncCalendarEvents upserts events and computes duration', () => {
    const db = freshDb();
    const result = syncCalendarEvents(db, [
      {
        id: 'evt-1',
        calendar_id: 'cal-work',
        summary: 'Standup',
        start: '2026-05-05T10:00:00Z',
        end: '2026-05-05T10:30:00Z',
        is_meeting: true,
      },
      {
        id: 'evt-2',
        calendar_id: 'cal-work',
        summary: 'Deep Work',
        start: '2026-05-05T14:00:00Z',
        end: '2026-05-05T16:00:00Z',
        is_meeting: false,
      },
    ]);

    expect(result.received).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.warnings).toEqual([]);

    const events = listCalendarEvents(db, '2026-05-05T00:00:00', '2026-05-05T23:59:59');
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('evt-1');
    expect(events[0].duration_minutes).toBe(30);
    expect(events[0].is_meeting).toBe(1);
    expect(events[1].id).toBe('evt-2');
    expect(events[1].duration_minutes).toBe(120);
    expect(events[1].is_meeting).toBe(0);
  });

  it('splits inserted vs updated across re-syncs', () => {
    const db = freshDb();
    const event = {
      id: 'evt-1',
      calendar_id: 'cal-work',
      summary: 'Standup',
      start: '2026-05-05T10:00:00Z',
      end: '2026-05-05T10:30:00Z',
      is_meeting: true,
    };
    const first = syncCalendarEvents(db, [event]);
    expect(first.inserted).toBe(1);
    expect(first.updated).toBe(0);

    const second = syncCalendarEvents(db, [event]);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
  });

  it('warns when the payload carries duplicate ids (upsert collapses them)', () => {
    const db = freshDb();
    const e = (summary: string) => ({
      id: 'evt-dup',
      calendar_id: 'cal-work',
      summary,
      start: '2026-05-05T10:00:00Z',
      end: '2026-05-05T11:00:00Z',
    });
    const result = syncCalendarEvents(db, [e('first'), e('second')]);
    expect(result.received).toBe(2);
    expect(result.inserted + result.updated).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/duplicate/);
  });

  it('listCalendarEvents returns events in date range', () => {
    const db = freshDb();
    syncCalendarEvents(db, [
      {
        id: 'mon',
        calendar_id: 'cal-a',
        summary: 'Monday',
        start: '2026-05-04T10:00:00Z',
        end: '2026-05-04T11:00:00Z',
      },
      {
        id: 'tue',
        calendar_id: 'cal-a',
        summary: 'Tuesday',
        start: '2026-05-05T10:00:00Z',
        end: '2026-05-05T11:00:00Z',
      },
      {
        id: 'wed',
        calendar_id: 'cal-a',
        summary: 'Wednesday',
        start: '2026-05-06T10:00:00Z',
        end: '2026-05-06T11:00:00Z',
      },
    ]);

    // Only query Tuesday
    const events = listCalendarEvents(db, '2026-05-05T00:00:00Z', '2026-05-05T23:59:59Z');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Tuesday');
  });

  it('upserts into time_entry with source=gcal-sync and external_id=event.id', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix, calendar_id) VALUES ('A', 'A', 'A', 'cal-a')`).run();
    syncCalendarEvents(db, [
      { id: 'evt-1', calendar_id: 'cal-a', project_id: 'A', summary: 'Standup', start: '2026-05-13T09:00:00Z', end: '2026-05-13T09:30:00Z', is_meeting: true },
    ]);
    const row = db.prepare(`SELECT status, source, external_id, project_id, is_meeting FROM time_entry WHERE external_id = 'evt-1'`).get() as any;
    expect(row.status).toBe('UNCONFIRMED');
    expect(row.source).toBe('gcal-sync');
    expect(row.project_id).toBe('A');
    expect(row.is_meeting).toBe(1);
  });

  it('preserves CONFIRMED status and actual_minutes when re-syncing the same event', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix, calendar_id) VALUES ('A', 'A', 'A', 'cal-a')`).run();
    syncCalendarEvents(db, [
      { id: 'evt-1', calendar_id: 'cal-a', project_id: 'A', summary: 'Standup', start: '2026-05-13T09:00:00Z', end: '2026-05-13T09:30:00Z', is_meeting: true },
    ]);
    // user confirms
    db.prepare(`UPDATE time_entry SET status='CONFIRMED', confirmed_at=datetime('now'), actual_minutes=25 WHERE external_id='evt-1'`).run();
    // re-sync same event
    syncCalendarEvents(db, [
      { id: 'evt-1', calendar_id: 'cal-a', project_id: 'A', summary: 'Standup', start: '2026-05-13T09:00:00Z', end: '2026-05-13T09:30:00Z', is_meeting: true },
    ]);
    const row = db.prepare(`SELECT status, actual_minutes FROM time_entry WHERE external_id='evt-1'`).get() as any;
    expect(row.status).toBe('CONFIRMED');
    expect(row.actual_minutes).toBe(25);
  });

  it('updates sync fields (start/end/is_meeting/notes) on re-sync without un-confirming', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix, calendar_id) VALUES ('A', 'A', 'A', 'cal-a')`).run();
    syncCalendarEvents(db, [
      { id: 'evt-1', calendar_id: 'cal-a', project_id: 'A', summary: 'Standup', start: '2026-05-13T09:00:00Z', end: '2026-05-13T09:30:00Z', is_meeting: true },
    ]);
    db.prepare(`UPDATE time_entry SET status='CONFIRMED', confirmed_at=datetime('now'), actual_minutes=25 WHERE external_id='evt-1'`).run();
    // user reschedules in gcal; re-sync sees new times
    syncCalendarEvents(db, [
      { id: 'evt-1', calendar_id: 'cal-a', project_id: 'A', summary: 'Standup (moved)', start: '2026-05-13T10:00:00Z', end: '2026-05-13T10:30:00Z', is_meeting: true },
    ]);
    const row = db.prepare(`SELECT status, start_at, end_at, notes FROM time_entry WHERE external_id='evt-1'`).get() as any;
    expect(row.status).toBe('CONFIRMED');         // unchanged
    expect(row.start_at).toBe('2026-05-13T10:00:00Z');  // updated
    expect(row.end_at).toBe('2026-05-13T10:30:00Z');    // updated
    expect(row.notes).toBe('Standup (moved)');     // updated
  });

  it('duplicate IDs are updated (not duplicated)', () => {
    const db = freshDb();

    syncCalendarEvents(db, [
      {
        id: 'evt-dup',
        calendar_id: 'cal-work',
        summary: 'Original Title',
        start: '2026-05-05T10:00:00Z',
        end: '2026-05-05T11:00:00Z',
        is_meeting: false,
      },
    ]);

    // Upsert same ID with new title
    syncCalendarEvents(db, [
      {
        id: 'evt-dup',
        calendar_id: 'cal-work',
        summary: 'Updated Title',
        start: '2026-05-05T10:00:00Z',
        end: '2026-05-05T11:30:00Z',
        is_meeting: true,
      },
    ]);

    const events = listCalendarEvents(db, '2026-05-05T00:00:00', '2026-05-05T23:59:59');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Updated Title');
    expect(events[0].duration_minutes).toBe(90);
    expect(events[0].is_meeting).toBe(1);
  });
});

describe('canonical UTC timestamp storage (#95)', () => {
  it('syncCalendarEvents normalizes offset-stamped event times and stamps canonical synced_at', () => {
    const db = freshDb();
    syncCalendarEvents(db, [
      {
        id: 'evt-tz',
        calendar_id: 'cal-work',
        summary: 'Evening sync',
        start: '2026-07-06T20:00:00-05:00',
        end: '2026-07-06T20:30:00-05:00',
        is_meeting: true,
      },
    ]);

    const row = db
      .prepare(`SELECT start_at, end_at, synced_at FROM time_entry WHERE external_id = 'evt-tz'`)
      .get() as any;
    expect(row.start_at).toBe('2026-07-07T01:00:00Z');
    expect(row.end_at).toBe('2026-07-07T01:30:00Z');
    expect(row.synced_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('window prune — mirror semantics (#93)', () => {
  const evt = (id: string, start: string, end: string) => ({
    id,
    calendar_id: 'cal-work',
    summary: `event ${id}`,
    start,
    end,
    is_meeting: true,
  });
  const WINDOW = { from: '2026-07-06', to: '2026-07-12' };

  it('prunes unconfirmed synced events in the window that are missing from the payload', () => {
    const db = freshDb();
    syncCalendarEvents(db, [
      evt('keep', '2026-07-07T10:00:00Z', '2026-07-07T10:30:00Z'),
      evt('cancelled', '2026-07-08T14:00:00Z', '2026-07-08T15:00:00Z'),
    ]);

    // Next sync: 'cancelled' was deleted in Google Calendar.
    const result = syncCalendarEvents(
      db,
      [evt('keep', '2026-07-07T10:00:00Z', '2026-07-07T10:30:00Z')],
      WINDOW,
    );

    expect(result.deleted).toBe(1);
    expect(result.pruned_events).toEqual([
      { id: 'cancelled', summary: 'event cancelled', start: '2026-07-08T14:00:00Z' },
    ]);
    const ids = db
      .prepare(`SELECT external_id FROM time_entry WHERE source = 'gcal-sync'`)
      .all()
      .map((r: any) => r.external_id);
    expect(ids).toEqual(['keep']);
  });

  it('never prunes CONFIRMED rows — confirmed time is historical', () => {
    const db = freshDb();
    syncCalendarEvents(db, [evt('done', '2026-07-07T10:00:00Z', '2026-07-07T11:00:00Z')]);
    db.prepare(`UPDATE time_entry SET status = 'CONFIRMED' WHERE external_id = 'done'`).run();

    const result = syncCalendarEvents(db, [], WINDOW, { allow_empty_prune: true });

    expect(result.deleted).toBe(0);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM time_entry WHERE external_id = 'done'`).get(),
    ).toEqual({ n: 1 });
  });

  it('never prunes placements, habits, or manual entries in the window', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    for (const source of ['placement', 'habit', 'manual'] as const) {
      db.prepare(`
        INSERT INTO time_entry (project_id, start_at, end_at, status, source, external_id)
        VALUES ('TEST', '2026-07-08T09:00:00Z', '2026-07-08T10:00:00Z', 'UNCONFIRMED', ?, ?)
      `).run(source, source === 'placement' ? 'gcal-evt-123' : null);
    }

    const result = syncCalendarEvents(db, [], WINDOW, { allow_empty_prune: true });

    expect(result.deleted).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM time_entry`).get()).toEqual({ n: 3 });
  });

  it('leaves rows outside the window alone', () => {
    const db = freshDb();
    syncCalendarEvents(db, [
      evt('last-week', '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z'),
      evt('next-month', '2026-08-03T10:00:00Z', '2026-08-03T11:00:00Z'),
    ]);

    const result = syncCalendarEvents(db, [], WINDOW, { allow_empty_prune: true });

    expect(result.deleted).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM time_entry`).get()).toEqual({ n: 2 });
  });

  it('plain-date window bounds are inclusive UTC day buckets', () => {
    const db = freshDb();
    syncCalendarEvents(db, [
      evt('first-day', '2026-07-06T08:00:00Z', '2026-07-06T09:00:00Z'),
      evt('last-day', '2026-07-12T22:00:00Z', '2026-07-12T23:00:00Z'),
    ]);

    const result = syncCalendarEvents(db, [], WINDOW, { allow_empty_prune: true });

    expect(result.deleted).toBe(2);
  });

  it('timestamp window bounds prune exactly the fetch range (#133)', () => {
    const db = freshDb();
    syncCalendarEvents(db, [
      evt('in-range', '2026-07-06T08:00:00Z', '2026-07-06T09:00:00Z'),
      evt('after-bound', '2026-07-12T22:00:00Z', '2026-07-12T23:00:00Z'),
    ]);

    // A day-bucket window would also prune 'after-bound'; exact
    // timestamps keep prune scope equal to fetch scope.
    const result = syncCalendarEvents(db, [], {
      from: '2026-07-06T00:00:00Z',
      to: '2026-07-12T00:00:00Z',
    }, { allow_empty_prune: true });

    expect(result.deleted).toBe(1);
    expect(result.pruned_events.map((e) => e.id)).toEqual(['in-range']);
  });

  it('timestamp bounds accept local offsets — the verbatim fetch timeMin/timeMax', () => {
    const db = freshDb();
    syncCalendarEvents(db, [
      // 7pm CDT Sunday = next-UTC-day Monday 00:00Z: the event that
      // UTC-day bucketing used to prune from a neighboring window.
      evt('sun-evening', '2026-07-13T00:00:00Z', '2026-07-13T01:00:00Z'),
    ]);

    const result = syncCalendarEvents(db, [], {
      from: '2026-07-06T00:00:00-05:00',
      to: '2026-07-12T23:59:59-05:00',
    }, { allow_empty_prune: true });

    // Sunday 7pm CDT is inside the local fetch range, so it prunes
    // only when genuinely missing from the payload — here it is.
    expect(result.deleted).toBe(1);
  });

  it('re-synced events keep their row identity and project assignment', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('ACME', 'Acme', 'ACME')`).run();
    syncCalendarEvents(db, [evt('standup', '2026-07-07T10:00:00Z', '2026-07-07T10:15:00Z')]);
    const before = db
      .prepare(`SELECT id FROM time_entry WHERE external_id = 'standup'`)
      .get() as any;

    syncCalendarEvents(
      db,
      [{ ...evt('standup', '2026-07-07T10:00:00Z', '2026-07-07T10:15:00Z'), project_id: 'ACME' }],
      WINDOW,
    );

    const after = db
      .prepare(`SELECT id, project_id FROM time_entry WHERE external_id = 'standup'`)
      .get() as any;
    expect(after.id).toBe(before.id);
    expect(after.project_id).toBe('ACME');
  });

  it('without a window, sync never prunes (backward compatible)', () => {
    const db = freshDb();
    syncCalendarEvents(db, [evt('a', '2026-07-07T10:00:00Z', '2026-07-07T11:00:00Z')]);
    const result = syncCalendarEvents(db, []);
    expect(result.deleted).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM time_entry`).get()).toEqual({ n: 1 });
  });
});

describe('prune guards (#133)', () => {
  const evt = (id: string, start: string, end: string) => ({
    id,
    calendar_id: 'cal-work',
    summary: `event ${id}`,
    start,
    end,
    is_meeting: true,
  });
  const WINDOW = { from: '2026-07-06', to: '2026-07-12' };

  it('refuses a window with an empty payload unless allow_empty_prune', () => {
    const db = freshDb();
    syncCalendarEvents(db, [evt('a', '2026-07-07T10:00:00Z', '2026-07-07T11:00:00Z')]);

    expect(() => syncCalendarEvents(db, [], WINDOW)).toThrow(/empty payload/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM time_entry`).get()).toEqual({ n: 1 });

    const allowed = syncCalendarEvents(db, [], WINDOW, { allow_empty_prune: true });
    expect(allowed.deleted).toBe(1);
  });

  it('refuses a mass prune, names the candidates, and honors confirm_prune', () => {
    const db = freshDb();
    // Ten synced events across the week; then a "partial payload" sync
    // of just two of them with the full-week window.
    const seeded = Array.from({ length: 10 }, (_, i) => {
      const day = String((i % 5) + 6).padStart(2, '0');
      return evt(`e${i}`, `2026-07-${day}T1${i % 8}:00:00Z`, `2026-07-${day}T1${i % 8}:30:00Z`);
    });
    syncCalendarEvents(db, seeded);

    const partial = seeded.slice(0, 2);
    const refused = syncCalendarEvents(db, partial, WINDOW);
    // 8 candidates > max(5, 2) → refused, nothing deleted.
    expect(refused.deleted).toBe(0);
    expect(refused.prune_refused).toHaveLength(8);
    expect(refused.prune_refused![0]).toHaveProperty('summary');
    expect(refused.warnings.join(' ')).toMatch(/prune refused/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM time_entry`).get()).toEqual({ n: 10 });

    const confirmed = syncCalendarEvents(db, partial, WINDOW, { confirm_prune: true });
    expect(confirmed.deleted).toBe(8);
    expect(confirmed.pruned_events).toHaveLength(8);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM time_entry`).get()).toEqual({ n: 2 });
  });

  it('small prunes stay unguarded — the routine cancelled-meeting case', () => {
    const db = freshDb();
    syncCalendarEvents(db, [
      evt('keep1', '2026-07-07T10:00:00Z', '2026-07-07T11:00:00Z'),
      evt('keep2', '2026-07-08T10:00:00Z', '2026-07-08T11:00:00Z'),
      evt('cancelled', '2026-07-09T10:00:00Z', '2026-07-09T11:00:00Z'),
    ]);

    const result = syncCalendarEvents(
      db,
      [
        evt('keep1', '2026-07-07T10:00:00Z', '2026-07-07T11:00:00Z'),
        evt('keep2', '2026-07-08T10:00:00Z', '2026-07-08T11:00:00Z'),
      ],
      WINDOW,
    );
    expect(result.deleted).toBe(1);
    expect(result.pruned_events.map((e) => e.id)).toEqual(['cancelled']);
  });
});
