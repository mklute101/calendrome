import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { computeWeekSupply } from '../src/supply.js';
import { createAvailabilityOverride } from '../src/availability.js';
import { createProject } from '../src/projects.js';
import { assignHours } from '../src/assignments.js';

/**
 * Week supply computation (#106, M4).
 *
 * The seeded categories (src/db/migrate.ts) give a fresh DB:
 *   work:     Mon–Fri 09:00–17:00 UTC → 5 × 480 = 2400 min/week
 *   personal: daily   18:00–22:00 UTC → 7 × 240 = 1680 min/week
 * Total 4080 min. 2026-07-13 is a Monday.
 */

const WEEK = '2026-07-13';

function addGcalEvent(
  db: any,
  start: string,
  end: string,
  status: 'UNCONFIRMED' | 'CONFIRMED' = 'UNCONFIRMED',
) {
  db.prepare(
    `INSERT INTO time_entry (start_at, end_at, status, source, is_meeting)
     VALUES (?, ?, ?, 'gcal-sync', 1)`,
  ).run(start, end, status);
}

function byCat(supply: ReturnType<typeof computeWeekSupply>, id: string) {
  const row = supply.by_category.find((c) => c.category_id === id);
  if (!row) throw new Error(`no supply row for category ${id}`);
  return row;
}

describe('computeWeekSupply', () => {
  it('rejects non-Monday week_start', () => {
    const db = freshDb();
    expect(() => computeWeekSupply(db, '2026-07-14')).toThrow(/Monday/);
    expect(() => computeWeekSupply(db, 'not-a-date')).toThrow();
  });

  it('empty week is pure window math from the seeded category windows', () => {
    const db = freshDb();
    const supply = computeWeekSupply(db, WEEK);

    expect(supply.week_start).toBe(WEEK);
    const work = byCat(supply, 'work');
    expect(work).toEqual({
      category_id: 'work',
      window_minutes: 2400,
      event_minutes: 0,
      blocked_minutes: 0,
      opened_minutes: 0,
      supply_minutes: 2400,
    });
    const personal = byCat(supply, 'personal');
    expect(personal.window_minutes).toBe(1680);
    expect(personal.supply_minutes).toBe(1680);
    expect(supply.total_supply_minutes).toBe(4080);
    expect(supply.assigned_minutes).toBe(0);
    expect(supply.to_be_assigned_minutes).toBe(4080);
  });

  it('a synced meeting inside the work window reduces work supply by its overlap only', () => {
    const db = freshDb();
    // Fully inside: Tue 10:00–11:00.
    addGcalEvent(db, '2026-07-14T10:00:00Z', '2026-07-14T11:00:00Z');
    // Straddles the window start: Wed 08:30–09:30 → only 30 min count.
    addGcalEvent(db, '2026-07-15T08:30:00Z', '2026-07-15T09:30:00Z', 'CONFIRMED');
    // Entirely outside any window: Wed 07:00–08:00 → counts nowhere.
    addGcalEvent(db, '2026-07-15T07:00:00Z', '2026-07-15T08:00:00Z');

    const supply = computeWeekSupply(db, WEEK);
    const work = byCat(supply, 'work');
    expect(work.event_minutes).toBe(90);
    expect(work.supply_minutes).toBe(2400 - 90);
    // Personal windows (evenings) are untouched.
    expect(byCat(supply, 'personal').supply_minutes).toBe(1680);
  });

  it('non-gcal entries (placements) never reduce supply', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO time_entry (start_at, end_at, source)
       VALUES ('2026-07-14T10:00:00Z', '2026-07-14T12:00:00Z', 'manual')`,
    ).run();
    expect(byCat(computeWeekSupply(db, WEEK), 'work').event_minutes).toBe(0);
  });

  it('overlapping events are merged before subtracting — no double subtraction', () => {
    const db = freshDb();
    addGcalEvent(db, '2026-07-14T10:00:00Z', '2026-07-14T11:00:00Z');
    addGcalEvent(db, '2026-07-14T10:30:00Z', '2026-07-14T11:30:00Z');

    const work = byCat(computeWeekSupply(db, WEEK), 'work');
    expect(work.event_minutes).toBe(90); // 10:00–11:30 once, not 120
    expect(work.supply_minutes).toBe(2400 - 90);
  });

  it('block_time carves out, and a block over an event does not double-subtract', () => {
    const db = freshDb();
    // Global block Tue 19:00–21:00 hits the personal evening window.
    createAvailabilityOverride(db, {
      start: '2026-07-14T19:00:00Z',
      end: '2026-07-14T21:00:00Z',
      available: 0,
    });
    // Work: event Wed 10:00–11:00 plus a block Wed 10:00–12:00 —
    // the shared 10–11 hour is already event-occupied, so the block
    // only removes 11–12.
    addGcalEvent(db, '2026-07-15T10:00:00Z', '2026-07-15T11:00:00Z');
    createAvailabilityOverride(db, {
      start: '2026-07-15T10:00:00Z',
      end: '2026-07-15T12:00:00Z',
      available: 0,
      category_id: 'work',
    });

    const supply = computeWeekSupply(db, WEEK);
    const personal = byCat(supply, 'personal');
    expect(personal.blocked_minutes).toBe(120);
    expect(personal.supply_minutes).toBe(1680 - 120);
    const work = byCat(supply, 'work');
    expect(work.event_minutes).toBe(60);
    expect(work.blocked_minutes).toBe(60);
    expect(work.supply_minutes).toBe(2400 - 120);
  });

  it('open_time adds supply outside the window, never inside it', () => {
    const db = freshDb();
    // Sat 09:00–12:00 opened for work — outside the Mon–Fri window.
    createAvailabilityOverride(db, {
      start: '2026-07-18T09:00:00Z',
      end: '2026-07-18T12:00:00Z',
      available: 1,
      category_id: 'work',
    });
    // Tue 10:00–12:00 opened for work — already inside the window,
    // adds nothing (the window counted it).
    createAvailabilityOverride(db, {
      start: '2026-07-14T10:00:00Z',
      end: '2026-07-14T12:00:00Z',
      available: 1,
      category_id: 'work',
    });

    const work = byCat(computeWeekSupply(db, WEEK), 'work');
    expect(work.opened_minutes).toBe(180);
    expect(work.supply_minutes).toBe(2400 + 180);
  });

  it('a global open_time is counted once, attributed to the first category', () => {
    const db = freshDb();
    // Sat 06:00–08:00, outside both windows, no category.
    createAvailabilityOverride(db, {
      start: '2026-07-18T06:00:00Z',
      end: '2026-07-18T08:00:00Z',
      available: 1,
    });

    const supply = computeWeekSupply(db, WEEK);
    expect(byCat(supply, 'work').opened_minutes).toBe(120);
    expect(byCat(supply, 'personal').opened_minutes).toBe(0);
    expect(supply.total_supply_minutes).toBe(4080 + 120);
  });

  it('opened swaths are carved by events and blocks (block wins over open)', () => {
    const db = freshDb();
    // Open Sat 09:00–12:00 for work…
    createAvailabilityOverride(db, {
      start: '2026-07-18T09:00:00Z',
      end: '2026-07-18T12:00:00Z',
      available: 1,
      category_id: 'work',
    });
    // …but a synced event sits on 09:00–10:00 and a block on 11:00–12:00.
    addGcalEvent(db, '2026-07-18T09:00:00Z', '2026-07-18T10:00:00Z');
    createAvailabilityOverride(db, {
      start: '2026-07-18T11:00:00Z',
      end: '2026-07-18T12:00:00Z',
      available: 0,
      category_id: 'work',
    });

    const work = byCat(computeWeekSupply(db, WEEK), 'work');
    expect(work.opened_minutes).toBe(60); // only 10:00–11:00 survives
  });

  it('to_be_assigned reflects effective assignments', () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme',
      prefix: 'ACME',
      weekly_budget_minutes: 600,
    });

    const supply = computeWeekSupply(db, WEEK);
    expect(supply.assigned_minutes).toBe(600); // standing cap, no explicit row
    expect(supply.to_be_assigned_minutes).toBe(4080 - 600);
  });

  it('overcommitting goes negative — scheduling debt made visible', () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme',
      prefix: 'ACME',
      weekly_budget_minutes: 600,
    });
    assignHours(db, {
      envelope_type: 'project',
      envelope_id: 'acme',
      week_start: WEEK,
      minutes: 5000,
    });

    const supply = computeWeekSupply(db, WEEK);
    expect(supply.assigned_minutes).toBe(5000);
    expect(supply.to_be_assigned_minutes).toBe(4080 - 5000); // −920
  });
});
