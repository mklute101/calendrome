/**
 * Availability overrides — the frictionless answer to "Tuesday night
 * I'm doing nothing — don't schedule anything."
 *
 * The thing Reclaim gets wrong is making ad-hoc schedule changes a
 * settings exercise. In calendrome, claiming or releasing time is a
 * single MCP call: `block_time` (available=0) reserves a window, and
 * `open_time` (available=1) carves out an extra slot inside a normally
 * blocked window ("Saturday morning is fair game"). `clear_availability`
 * wipes overrides in a range so the user never has to remember IDs.
 *
 * Overrides can be scoped to a single category (`category_id` set) or
 * apply globally (`category_id` null). The planner consults this table
 * before suggesting placements; the actual "respect the window" logic
 * lives in the planner skill, not here — this module is just storage.
 */
import type { DB } from './db/connection.js';
import { now } from './clock.js';
import { toCanonicalUtc } from './day-range.js';

export interface AvailabilityOverride {
  id: number;
  start: string;
  end: string;
  available: number; // 0 = blocked, 1 = open
  category_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface CreateOverrideInput {
  start: string;
  end: string;
  available: 0 | 1;
  category_id?: string | null;
  reason?: string | null;
}

export function createAvailabilityOverride(
  db: DB,
  input: CreateOverrideInput,
): AvailabilityOverride {
  // Canonical UTC storage form, same as time_entry (#95, #145):
  // offset-stamped inputs are converted, never persisted verbatim, so
  // range reads can compare strings without mixed-form hazards.
  const start = toCanonicalUtc(input.start, 'start');
  const end = toCanonicalUtc(input.end, 'end');
  if (end <= start) {
    throw new Error('availability override: end must be after start');
  }
  const result = db
    .prepare(
      `INSERT INTO availability_overrides (start, end, available, category_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      start,
      end,
      input.available,
      input.category_id ?? null,
      input.reason ?? null,
      now(),
    );
  const id = Number(result.lastInsertRowid);
  return getAvailabilityOverride(db, id) as AvailabilityOverride;
}

export function getAvailabilityOverride(
  db: DB,
  id: number,
): AvailabilityOverride | null {
  const row = db
    .prepare('SELECT * FROM availability_overrides WHERE id = ?')
    .get(id) as AvailabilityOverride | undefined;
  return row ?? null;
}

export interface ListOverridesOpts {
  from?: string;
  to?: string;
  category_id?: string | null;
}

export function listAvailabilityOverrides(
  db: DB,
  opts: ListOverridesOpts = {},
): AvailabilityOverride[] {
  const where: string[] = [];
  const values: unknown[] = [];
  // Bounds go through toCanonicalUtc too: stored rows are canonical
  // UTC, so an offset-stamped bound would corrupt the string compare.
  if (opts.from) {
    where.push('end > ?');
    values.push(toCanonicalUtc(opts.from, 'from'));
  }
  if (opts.to) {
    where.push('start < ?');
    values.push(toCanonicalUtc(opts.to, 'to'));
  }
  if (opts.category_id !== undefined) {
    if (opts.category_id === null) {
      where.push('category_id IS NULL');
    } else {
      where.push('category_id = ?');
      values.push(opts.category_id);
    }
  }
  const sql =
    'SELECT * FROM availability_overrides' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY start';
  return db.prepare(sql).all(...values) as AvailabilityOverride[];
}

export function deleteAvailabilityOverride(db: DB, id: number): void {
  db.prepare('DELETE FROM availability_overrides WHERE id = ?').run(id);
}

export interface ClearOverridesOpts {
  start: string;
  end: string;
  category_id?: string | null;
}

/**
 * Remove every override fully contained in [start, end]. Useful for
 * "clear my Tuesday night block" — the planner skill calls this when
 * you change your mind without making the user remember override IDs.
 */
export function clearAvailabilityOverrides(
  db: DB,
  opts: ClearOverridesOpts,
): number {
  const where: string[] = ['start >= ?', 'end <= ?'];
  const values: unknown[] = [
    toCanonicalUtc(opts.start, 'start'),
    toCanonicalUtc(opts.end, 'end'),
  ];
  if (opts.category_id !== undefined) {
    if (opts.category_id === null) {
      where.push('category_id IS NULL');
    } else {
      where.push('category_id = ?');
      values.push(opts.category_id);
    }
  }
  const result = db
    .prepare(
      `DELETE FROM availability_overrides WHERE ${where.join(' AND ')}`,
    )
    .run(...values);
  return Number(result.changes);
}
