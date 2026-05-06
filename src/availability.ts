import type { DB } from './db/connection.js';

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
  if (Date.parse(input.end) <= Date.parse(input.start)) {
    throw new Error('availability override: end must be after start');
  }
  const result = db
    .prepare(
      `INSERT INTO availability_overrides (start, end, available, category_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.start,
      input.end,
      input.available,
      input.category_id ?? null,
      input.reason ?? null,
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
  if (opts.from) {
    where.push('end > ?');
    values.push(opts.from);
  }
  if (opts.to) {
    where.push('start < ?');
    values.push(opts.to);
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
  const values: unknown[] = [opts.start, opts.end];
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
