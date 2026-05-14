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

function isoUtcMinute(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
): string {
  return `${y}-${pad(m)}-${pad(d)}T${pad(hour)}:${pad(minute)}:00Z`;
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
 * NOTE: For Phase 1, only `UTC` timezone is fully supported. Other
 * timezones treat the start_time as UTC. Phase 2 will integrate proper
 * timezone handling alongside Google Calendar.
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

  const startMs = Date.parse(`${fromDate}T00:00:00Z`);
  const endMs = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
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

  const generateTx = db.transaction(() => {
    for (let t = startMs; t <= endMs; t += 86_400_000) {
      const dt = new Date(t);
      if (!days.has(dt.getUTCDay())) continue;
      const y = dt.getUTCFullYear();
      const m = dt.getUTCMonth() + 1;
      const d = dt.getUTCDate();

      const start = isoUtcMinute(y, m, d, hh, mm);
      const endDt = new Date(Date.UTC(y, m - 1, d, hh, mm + dur));
      const end = isoUtcMinute(
        endDt.getUTCFullYear(),
        endDt.getUTCMonth() + 1,
        endDt.getUTCDate(),
        endDt.getUTCHours(),
        endDt.getUTCMinutes(),
      );

      const result = insert.run(habitId, start, end);
      if (result.changes === 0) continue; // already existed — don't double-write
      const instanceId = Number(result.lastInsertRowid);
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

  return db
    .prepare(
      `SELECT * FROM habit_instances
       WHERE habit_id = ?
         AND scheduled_start >= ?
         AND scheduled_start <= ?
       ORDER BY scheduled_start`,
    )
    .all(
      habitId,
      `${fromDate}T00:00:00Z`,
      `${toDate}T23:59:59Z`,
    ) as HabitInstance[];
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
