import type { DB } from './db/connection.js';
import { now } from './clock.js';
import {
  addDays,
  localDayOf,
  mondayOfDay,
  toCanonicalUtc,
  weekRange,
  zonedTimeToUtcMs,
} from './day-range.js';
import {
  confirmTimeEntry,
  insertTimeEntry,
  moveTimeEntry,
  skipTimeEntry,
  type TimeEntryRow,
} from './time-entry.js';

export interface Habit {
  id: number;
  project_id: string;
  title: string;
  notes: string | null;
  duration_minutes: number;
  /** Fixed-days form: CSV of weekday numbers. '' when times_per_week is set. */
  days_of_week: string;
  /** N-per-week target form (#106). NULL for fixed-days habits. */
  times_per_week: number | null;
  start_time: string;
  timezone: string;
  active: number;
  created_at: string;
}

export interface HabitInstance {
  id: number;
  habit_id: number;
  /** Immutable slot identity — the regeneration dedupe key; never
   *  rewritten by a move. The linked entry's start/end is display truth. */
  scheduled_start: string;
  scheduled_end: string;
  status: 'PLANNED' | 'COMPLETE' | 'SKIPPED';
  calendar_event_id: string | null;
  completed_at: string | null;
  time_entry_id: number | null;
}

export interface CreateHabitInput {
  project_id: string;
  title: string;
  notes?: string | null;
  duration_minutes: number;
  /** Exactly one of days_of_week / times_per_week must be provided. */
  days_of_week?: string;
  times_per_week?: number;
  start_time: string;
  timezone?: string;
}

export interface UpdateHabitInput {
  title?: string;
  notes?: string | null;
  duration_minutes?: number;
  days_of_week?: string;
  times_per_week?: number | null;
  start_time?: string;
  timezone?: string;
  active?: number;
}

/**
 * A habit's frequency comes in exactly one of two forms (#106):
 * fixed days (`days_of_week` CSV) or an N-per-week target
 * (`times_per_week`). The DB keeps `days_of_week NOT NULL` for legacy
 * compatibility, so the target form stores `''` there. Enforced here,
 * not by CHECK — migration constraints on existing tables aren't
 * available.
 */
function validateFrequency(
  daysOfWeek: string | null,
  timesPerWeek: number | null,
): void {
  const hasDays = daysOfWeek !== null && daysOfWeek !== '';
  const hasTimes = timesPerWeek !== null;
  if (hasDays === hasTimes) {
    throw new Error(
      'a habit must have exactly one of days_of_week or times_per_week',
    );
  }
  if (hasDays) parseDaysOfWeek(daysOfWeek as string);
  if (hasTimes && (!Number.isInteger(timesPerWeek) || (timesPerWeek as number) < 1 || (timesPerWeek as number) > 7)) {
    throw new Error(`times_per_week must be an integer 1..7, got: ${timesPerWeek}`);
  }
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

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function weekdayOfIsoDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function createHabit(db: DB, input: CreateHabitInput): Habit {
  const daysOfWeek = input.days_of_week ?? null;
  const timesPerWeek = input.times_per_week ?? null;
  validateFrequency(daysOfWeek, timesPerWeek);
  const result = db
    .prepare(
      `INSERT INTO habits
        (project_id, title, notes, duration_minutes, days_of_week, times_per_week, start_time, timezone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.project_id,
      input.title,
      input.notes ?? null,
      input.duration_minutes,
      daysOfWeek ?? '',
      timesPerWeek,
      input.start_time,
      input.timezone ?? 'UTC',
      now(),
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
  const existing = getHabit(db, id);
  if (!existing) throw new Error(`habit ${id} not found`);

  // Switching forms: setting one side implicitly clears the other,
  // so "make this a 4×/week habit" is a one-field patch. Passing both
  // (non-empty days + non-null times) is rejected by validateFrequency.
  const resolved = { ...patch };
  if (patch.times_per_week != null && patch.days_of_week === undefined) {
    resolved.days_of_week = '';
  }
  if (
    patch.days_of_week !== undefined &&
    patch.days_of_week !== '' &&
    patch.times_per_week === undefined
  ) {
    resolved.times_per_week = null;
  }
  const days =
    resolved.days_of_week !== undefined ? resolved.days_of_week : existing.days_of_week;
  const times =
    resolved.times_per_week !== undefined
      ? resolved.times_per_week
      : existing.times_per_week;
  validateFrequency(days === '' ? null : days, times);

  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(resolved)) {
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

  const [hh, mm] = habit.start_time.split(':').map(Number);
  const dur = habit.duration_minutes;
  const tz = habit.timezone || 'UTC';

  // Validate the date range parses.
  if (Number.isNaN(Date.parse(`${fromDate}T00:00:00Z`)) ||
      Number.isNaN(Date.parse(`${toDate}T00:00:00Z`))) {
    throw new Error(`invalid date range: ${fromDate}..${toDate}`);
  }

  // Which dates in the range get an instance?
  //  - Fixed-days form: every date whose weekday is in days_of_week.
  //  - N-per-week target form (#106): the first N days of the range.
  //    These are *candidates* — mobility lets them slide anywhere in
  //    the week; the anchor is just a materialization convenience.
  const dates: string[] = [];
  if (habit.times_per_week != null) {
    for (
      let date = fromDate;
      date <= toDate && dates.length < habit.times_per_week;
      date = addDays(date, 1)
    ) {
      dates.push(date);
    }
  } else {
    const days = new Set(parseDaysOfWeek(habit.days_of_week));
    for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
      if (days.has(weekdayOfIsoDate(date))) dates.push(date);
    }
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
    for (const date of dates) {
      // Wall clock -> UTC through the shared helper (src/day-range.ts),
      // whose two-pass offset lookup is right on both DST nights: the
      // skipped spring hour shifts back, and the hours after a
      // fall-back use the new offset (the old single-pass version put
      // post-fall-back times one hour early).
      const startMs = zonedTimeToUtcMs(date, `${pad2(hh)}:${pad2(mm)}`, tz);
      const start = toCanonicalUtc(new Date(startMs).toISOString(), 'scheduled_start');
      const end = toCanonicalUtc(
        new Date(startMs + dur * 60_000).toISOString(),
        'scheduled_end',
      );

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
      "UPDATE habit_instances SET status = 'COMPLETE', completed_at = ? WHERE id = ?",
    ).run(now(), id);
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

/**
 * Move a PLANNED habit instance's linked time_entry within the habit's
 * frequency range (#118, spec: 2026-07-17-commitment-taxonomy-design).
 *
 * The frequency range is the load-bearing rule: sliding *within* it is
 * a move; leaving it is a skip, never a move. Enforced server-side:
 *  - fixed-days form: the new start must land on the same local day
 *    (in the habit's timezone) as `scheduled_start` — a Mon/Wed/Fri
 *    instance slides within its own day only.
 *  - times_per_week form: the new start must stay inside the instance's
 *    Mon-Sun week — an N-per-week candidate slides anywhere in its week.
 *
 * `habit_instances.scheduled_start` is the immutable slot identity
 * (UNIQUE(habit_id, scheduled_start) is the regeneration dedupe) and is
 * never rewritten; the linked entry's start/end is the display truth.
 * `newEnd` exists for parity with `moveTimeEntry` but a habit's chunk
 * size is its instance duration (non-combinable) — callers normally
 * omit it and the duration is preserved.
 */
export function moveHabitInstance(
  db: DB,
  id: number,
  newStart: string,
  opts: { newEnd?: string } = {},
): { instance: HabitInstance; entry: TimeEntryRow } {
  const moveTx = db.transaction(() => {
    const inst = db
      .prepare('SELECT * FROM habit_instances WHERE id = ?')
      .get(id) as HabitInstance | undefined;
    if (!inst) throw new Error(`habit_instance ${id} not found`);
    if (inst.status !== 'PLANNED') {
      throw new Error(
        `cannot move habit_instance ${id}: status is ${inst.status}, not PLANNED`,
      );
    }
    if (inst.time_entry_id == null) {
      throw new Error(`habit_instance ${id} has no linked time_entry`);
    }
    const habit = getHabit(db, inst.habit_id);
    if (!habit) throw new Error(`habit ${inst.habit_id} not found`);

    const startCanon = toCanonicalUtc(newStart, 'new_start');
    const tz = habit.timezone || 'UTC';
    if (habit.times_per_week != null) {
      // Target form: anywhere in the instance's Mon-Sun week.
      const fromWeek = mondayOfDay(localDayOf(new Date(inst.scheduled_start), tz));
      const toWeek = mondayOfDay(localDayOf(new Date(startCanon), tz));
      if (fromWeek !== toWeek) {
        throw new Error(
          `cannot move habit_instance ${id} out of its week (${fromWeek}): leaving the frequency range is a skip, not a move`,
        );
      }
    } else {
      // Fixed-days form: within its own day only.
      const fromDay = localDayOf(new Date(inst.scheduled_start), tz);
      const toDay = localDayOf(new Date(startCanon), tz);
      if (fromDay !== toDay) {
        throw new Error(
          `cannot move habit_instance ${id} off its day (${fromDay}): leaving the frequency range is a skip, not a move`,
        );
      }
    }

    moveTimeEntry(db, inst.time_entry_id, startCanon, {
      new_end_at: opts.newEnd,
    });
  });
  moveTx();

  const instance = db
    .prepare('SELECT * FROM habit_instances WHERE id = ?')
    .get(id) as HabitInstance;
  const entry = db
    .prepare('SELECT * FROM time_entry WHERE id = ?')
    .get(instance.time_entry_id) as TimeEntryRow;
  return { instance, entry };
}

/**
 * Weekly frequency meter for a habit (#106): COMPLETE instances in the
 * week over the habit's target — `times_per_week` for the N-per-week
 * form, the number of listed days for the fixed-days form. "3/4 this
 * week", not a skip list.
 */
export function habitWeekScore(
  db: DB,
  habitId: number,
  weekStart: string,
): { done: number; target: number } {
  const habit = getHabit(db, habitId);
  if (!habit) throw new Error(`habit ${habitId} not found`);
  // The week is local Monday-to-Monday in the habit's *own* timezone
  // (#146): instances are materialized by `generateHabitInstances` in
  // `habits.timezone`, so scoring must bucket by the same clock or a
  // Sunday-evening instance under a differently-zoned category would
  // score in the wrong week. This deliberately departs from the
  // project -> category chain the other envelopes use.
  const { startIso, endIso } = weekRange(weekStart, habit.timezone || 'UTC');

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM habit_instances
        WHERE habit_id = ? AND status = 'COMPLETE'
          AND scheduled_start >= ? AND scheduled_start < ?`,
    )
    .get(habitId, startIso, endIso) as { n: number };

  const target =
    habit.times_per_week != null
      ? habit.times_per_week
      : parseDaysOfWeek(habit.days_of_week).length;
  return { done: row.n, target };
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
