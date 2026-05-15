import type { DB } from './db/connection.js';
import {
  confirmTimeEntry,
  insertTimeEntry,
  skipTimeEntry,
} from './time-entry.js';

export interface Habit {
  id: number;
  project_id: string;
  title: string;
  notes: string | null;
  duration_minutes: number;
  days_of_week: string;
  start_time: string;
  timezone: string;
  active: number;
  created_at: string;
}

export interface HabitInstance {
  id: number;
  habit_id: number;
  scheduled_start: string;
  scheduled_end: string;
  status: 'PLANNED' | 'COMPLETE' | 'SKIPPED';
  calendar_event_id: string | null;
  completed_at: string | null;
}

export interface CreateHabitInput {
  project_id: string;
  title: string;
  notes?: string | null;
  duration_minutes: number;
  days_of_week: string;
  start_time: string;
  timezone?: string;
}

export interface UpdateHabitInput {
  title?: string;
  notes?: string | null;
  duration_minutes?: number;
  days_of_week?: string;
  start_time?: string;
  timezone?: string;
  active?: number;
}

function parseDaysOfWeek(s: string): number[] {
  const parts = s.split(',').map((p) => p.trim());
  const days = parts.map((p) => Number(p));
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new Error(`invalid days_of_week value: "${s}"`);
    }
  }
  return days;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/**
 * Convert a wall-clock date+time in a named IANA timezone to its UTC `Date`.
 *
 * Strategy: treat (y, m, d, hh, mm) as a UTC instant ("guess"), format that
 * instant in the target zone to discover the wall clock the zone *would*
 * show for it, and use the difference as the offset. Handles DST correctly
 * because the offset is derived from the actual zone rules at that point in
 * the year. Ambiguous times across DST fall-back resolve to the earlier
 * offset (the formatter returns a single value).
 */
function zonedWallclockToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const guessMs = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(guessMs))) {
    parts[p.type] = p.value;
  }
  // en-US with hour12:false emits "24" for midnight on some runtimes — normalize.
  const hourInZone = parts.hour === '24' ? 0 : Number(parts.hour);
  const zoneWallMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hourInZone,
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = zoneWallMs - guessMs;
  return new Date(guessMs - offsetMs);
}

function toIsoMinute(dt: Date): string {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:00Z`;
}

function addDaysIsoDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function weekdayOfIsoDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function createHabit(db: DB, input: CreateHabitInput): Habit {
  parseDaysOfWeek(input.days_of_week); // validates
  const result = db
    .prepare(
      `INSERT INTO habits
        (project_id, title, notes, duration_minutes, days_of_week, start_time, timezone)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.project_id,
      input.title,
      input.notes ?? null,
      input.duration_minutes,
      input.days_of_week,
      input.start_time,
      input.timezone ?? 'UTC',
    );
  return getHabit(db, Number(result.lastInsertRowid)) as Habit;
}

export function getHabit(db: DB, id: number): Habit | null {
  const row = db.prepare('SELECT * FROM habits WHERE id = ?').get(id) as
    | Habit
    | undefined;
  return row ?? null;
}

export function updateHabit(
  db: DB,
  id: number,
  patch: UpdateHabitInput,
): Habit {
  if (patch.days_of_week !== undefined) parseDaysOfWeek(patch.days_of_week);
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE habits SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
  return getHabit(db, id) as Habit;
}

export function listHabits(
  db: DB,
  opts: { active?: boolean } = {},
): Habit[] {
  if (opts.active === undefined) {
    return db.prepare('SELECT * FROM habits ORDER BY id').all() as Habit[];
  }
  return db
    .prepare('SELECT * FROM habits WHERE active = ? ORDER BY id')
    .all(opts.active ? 1 : 0) as Habit[];
}

export function deactivateHabit(db: DB, id: number): void {
  db.prepare('UPDATE habits SET active = 0 WHERE id = ?').run(id);
}

/**
 * Generate one habit_instance per matching weekday in the inclusive date
 * range. Idempotent: re-running for the same range will not create
 * duplicates (UNIQUE(habit_id, scheduled_start) enforces this).
 *
 * The date range is interpreted in the habit's local timezone — a habit at
 * "11:30 America/Chicago" generated for 2026-05-04..2026-05-04 produces an
 * instance at `2026-05-04T16:30:00Z` (CDT, UTC-5). DST transitions inside
 * the range are handled correctly because the wall-clock → UTC conversion
 * resolves the offset per-date.
 */
export function generateHabitInstances(
  db: DB,
  habitId: number,
  fromDate: string,
  toDate: string,
): HabitInstance[] {
  const habit = getHabit(db, habitId);
  if (!habit) throw new Error(`habit ${habitId} not found`);

  const days = new Set(parseDaysOfWeek(habit.days_of_week));
  const [hh, mm] = habit.start_time.split(':').map(Number);
  const dur = habit.duration_minutes;
  const tz = habit.timezone || 'UTC';

  // Validate the date range parses.
  if (Number.isNaN(Date.parse(`${fromDate}T00:00:00Z`)) ||
      Number.isNaN(Date.parse(`${toDate}T00:00:00Z`))) {
    throw new Error(`invalid date range: ${fromDate}..${toDate}`);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO habit_instances
        (habit_id, scheduled_start, scheduled_end)
     VALUES (?, ?, ?)`,
  );
  const linkTimeEntry = db.prepare(
    `UPDATE habit_instances SET time_entry_id = ? WHERE id = ?`,
  );
  const lookupExisting = db.prepare(
    `SELECT id FROM habit_instances WHERE habit_id = ? AND scheduled_start = ?`,
  );

  const touchedIds: number[] = [];

  const generateTx = db.transaction(() => {
    for (let date = fromDate; date <= toDate; date = addDaysIsoDate(date, 1)) {
      if (!days.has(weekdayOfIsoDate(date))) continue;
      const [y, m, d] = date.split('-').map(Number);

      const startDt = zonedWallclockToUtc(y, m, d, hh, mm, tz);
      const endDt = new Date(startDt.getTime() + dur * 60_000);
      const start = toIsoMinute(startDt);
      const end = toIsoMinute(endDt);

      const result = insert.run(habitId, start, end);
      if (result.changes === 0) {
        const existing = lookupExisting.get(habitId, start) as { id: number } | undefined;
        if (existing) touchedIds.push(existing.id);
        continue;
      }
      const instanceId = Number(result.lastInsertRowid);
      touchedIds.push(instanceId);
      const teId = insertTimeEntry(db, {
        task_id: null,
        project_id: habit.project_id,
        start_at: start,
        end_at: end,
        status: 'UNCONFIRMED',
        source: 'habit',
        notes: habit.title,
      });
      linkTimeEntry.run(teId, instanceId);
    }
  });
  generateTx();

  if (touchedIds.length === 0) return [];

  const placeholders = touchedIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT * FROM habit_instances
       WHERE id IN (${placeholders})
       ORDER BY scheduled_start`,
    )
    .all(...touchedIds) as HabitInstance[];
}

export function completeHabitInstance(
  db: DB,
  id: number,
): HabitInstance {
  const completeTx = db.transaction(() => {
    db.prepare(
      "UPDATE habit_instances SET status = 'COMPLETE', completed_at = datetime('now') WHERE id = ?",
    ).run(id);
    const row = db
      .prepare('SELECT time_entry_id FROM habit_instances WHERE id = ?')
      .get(id) as { time_entry_id: number | null } | undefined;
    if (row?.time_entry_id != null) {
      confirmTimeEntry(db, row.time_entry_id, {});
    }
  });
  completeTx();
  return db
    .prepare('SELECT * FROM habit_instances WHERE id = ?')
    .get(id) as HabitInstance;
}

export function skipHabitInstance(db: DB, id: number): HabitInstance {
  const skipTx = db.transaction(() => {
    const row = db
      .prepare('SELECT time_entry_id FROM habit_instances WHERE id = ?')
      .get(id) as { time_entry_id: number | null } | undefined;
    db.prepare(
      "UPDATE habit_instances SET status = 'SKIPPED', time_entry_id = NULL WHERE id = ?",
    ).run(id);
    if (row?.time_entry_id != null) {
      skipTimeEntry(db, row.time_entry_id);
    }
  });
  skipTx();
  return db
    .prepare('SELECT * FROM habit_instances WHERE id = ?')
    .get(id) as HabitInstance;
}
