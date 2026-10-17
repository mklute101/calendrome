import type { DB } from './db/connection.js';
import { projectTimezone } from './categories.js';
import { now } from './clock.js';
import {
  addDays,
  assertValidTimezone,
  localDayOf,
  mondayOfDay,
  toCanonicalUtc,
  weekRange,
  zonedTimeToUtcMs,
  type WeekRange,
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
  project_id?: string;
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
  // The habit's clock is what its instances are materialized in and
  // what its week scoring follows (#146). Default to the project's
  // category timezone so a habit created without one is scored on the
  // same clock its budget is; reject names Intl does not know.
  const timezone = input.timezone ?? projectTimezone(db, input.project_id);
  assertValidTimezone(timezone);
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
      timezone,
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
 * Generate habit_instances for the inclusive local date range.
 * Idempotent: re-running for the same range creates nothing new.
 *
 * Dedupe is by occupancy, not by exact slot, so a schedule edit or a
 * moved/placed instance never doubles up a day (#129, #131):
 *  - fixed-days form: a listed date gets an instance only when the
 *    habit has no instance (any status) whose `scheduled_start` falls
 *    on that local date.
 *  - N-per-week target form (#106): each local Mon-Sun week is filled
 *    up to N instances (any status counts, so a skip is not refilled),
 *    on the earliest dates in range that have none. These are
 *    *candidates* — they slide anywhere in the week.
 *
 * The date range is interpreted in the habit's local timezone — a habit at
 * "11:30 America/Chicago" generated for 2026-05-04..2026-05-04 produces an
 * instance at `2026-05-04T16:30:00Z` (CDT, UTC-5). DST transitions inside
 * the range are handled correctly because the wall-clock → UTC conversion
 * resolves the offset per-date. A retired habit generates nothing.
 */
export function generateHabitInstances(
  db: DB,
  habitId: number,
  fromDate: string,
  toDate: string,
): HabitInstance[] {
  const habit = getHabit(db, habitId);
  if (!habit) throw new Error(`habit ${habitId} not found`);
  if (!habit.active) throw new Error(`habit ${habitId} is retired`);

  const tz = habit.timezone || 'UTC';

  // Validate the date range parses.
  if (Number.isNaN(Date.parse(`${fromDate}T00:00:00Z`)) ||
      Number.isNaN(Date.parse(`${toDate}T00:00:00Z`))) {
    throw new Error(`invalid date range: ${fromDate}..${toDate}`);
  }

  const generateTx = db.transaction(() => {
    // Existing occupancy, keyed by local date, over the range widened
    // to whole weeks (the target form counts its full week).
    const occupied = new Map<string, number>();
    const span = { from: mondayOfDay(fromDate), to: addDays(mondayOfDay(toDate), 6) };
    for (const r of instancesInLocalDays(db, habit, span.from, span.to)) {
      const day = localDayOf(new Date(r.scheduled_start), tz);
      occupied.set(day, (occupied.get(day) ?? 0) + 1);
    }

    const dates: string[] = [];
    if (habit.times_per_week != null) {
      const perWeek = new Map<string, number>();
      for (const [day, n] of occupied) {
        const wk = mondayOfDay(day);
        perWeek.set(wk, (perWeek.get(wk) ?? 0) + n);
      }
      for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
        const wk = mondayOfDay(date);
        const have = perWeek.get(wk) ?? 0;
        if (have >= habit.times_per_week || occupied.has(date)) continue;
        dates.push(date);
        perWeek.set(wk, have + 1);
      }
    } else {
      const days = new Set(parseDaysOfWeek(habit.days_of_week));
      for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
        if (days.has(weekdayOfIsoDate(date)) && !occupied.has(date)) dates.push(date);
      }
    }

    for (const date of dates) {
      // Wall clock -> UTC through the shared helper (src/day-range.ts),
      // whose two-pass offset lookup is right on both DST nights.
      const [hh, mm] = habit.start_time.split(':').map(Number);
      const startMs = zonedTimeToUtcMs(date, `${pad2(hh)}:${pad2(mm)}`, tz);
      insertInstance(db, habit, new Date(startMs).toISOString());
    }
  });
  generateTx();

  return instancesInLocalDays(db, habit, fromDate, toDate);
}

/** A habit's instances whose `scheduled_start` falls on a local date in
 *  `[from, to]` (habit timezone), ordered by slot. */
function instancesInLocalDays(
  db: DB,
  habit: Habit,
  from: string,
  to: string,
): HabitInstance[] {
  const tz = habit.timezone || 'UTC';
  const startIso = weekRange(mondayOfDay(from), tz).startIso;
  const endIso = weekRange(mondayOfDay(to), tz).endIso;
  return (
    db
      .prepare(
        `SELECT * FROM habit_instances
          WHERE habit_id = ? AND scheduled_start >= ? AND scheduled_start < ?
          ORDER BY scheduled_start`,
      )
      .all(habit.id, startIso, endIso) as HabitInstance[]
  ).filter((r) => {
    const day = localDayOf(new Date(r.scheduled_start), tz);
    return day >= from && day <= to;
  });
}

/**
 * Insert one PLANNED instance at `start` plus its linked UNCONFIRMED
 * habit entry, sized by the habit's duration. Caller owns the
 * transaction. UNIQUE(habit_id, scheduled_start) surfaces as a clear
 * error rather than a raw constraint message.
 */
function insertInstance(db: DB, habit: Habit, start: string): number {
  const startCanon = toCanonicalUtc(start, 'scheduled_start');
  const end = toCanonicalUtc(
    new Date(new Date(startCanon).getTime() + habit.duration_minutes * 60_000).toISOString(),
    'scheduled_end',
  );
  const taken = db
    .prepare('SELECT id FROM habit_instances WHERE habit_id = ? AND scheduled_start = ?')
    .get(habit.id, startCanon) as { id: number } | undefined;
  if (taken) {
    throw new Error(
      `habit ${habit.id} already has an instance at ${startCanon} (habit_instance ${taken.id})`,
    );
  }
  const instanceId = Number(
    db
      .prepare(
        `INSERT INTO habit_instances (habit_id, scheduled_start, scheduled_end)
         VALUES (?, ?, ?)`,
      )
      .run(habit.id, startCanon, end).lastInsertRowid,
  );
  const teId = insertTimeEntry(db, {
    task_id: null,
    project_id: habit.project_id,
    start_at: startCanon,
    end_at: end,
    status: 'UNCONFIRMED',
    source: 'habit',
    notes: habit.title,
  });
  db.prepare('UPDATE habit_instances SET time_entry_id = ? WHERE id = ?').run(teId, instanceId);
  return instanceId;
}

/** Instances-per-week target: `times_per_week`, or the listed-day count. */
function weeklyTarget(habit: Habit): number {
  return habit.times_per_week != null
    ? habit.times_per_week
    : parseDaysOfWeek(habit.days_of_week).length;
}

/**
 * Put one habit instance on the calendar at `start` (#138), outside
 * the generated schedule: a skipped Monday made up on Tuesday, or a
 * 3x/week session dropped onto Saturday.
 *
 * The habit's local week is materialized first, then the placement is
 * allowed only while that week is under target — PLANNED + COMPLETE
 * instances below `weeklyTarget` (a skip frees its slot). Any time of
 * day is valid; out-of-window placement is the caller's informational
 * note, never a refusal. Duration is the habit's instance duration.
 */
export function placeHabitInstance(
  db: DB,
  habitId: number,
  start: string,
): { instance: HabitInstance; entry: TimeEntryRow } {
  const placeTx = db.transaction((): number => {
    const habit = getHabit(db, habitId);
    if (!habit) throw new Error(`habit ${habitId} not found`);
    if (!habit.active) throw new Error(`habit ${habitId} is retired; it cannot be placed`);
    const startCanon = toCanonicalUtc(start, 'start');
    const tz = habit.timezone || 'UTC';
    const week = mondayOfDay(localDayOf(new Date(startCanon), tz));
    generateHabitInstances(db, habitId, week, addDays(week, 6));
    const { remaining, target } = habitWeekRemaining(db, habit, week);
    if (remaining <= 0) {
      throw new Error(
        `habit ${habitId} already meets its target of ${target} for the week of ${week}; skip an instance to free a slot`,
      );
    }
    return insertInstance(db, habit, startCanon);
  });
  const id = placeTx();
  const instance = db
    .prepare('SELECT * FROM habit_instances WHERE id = ?')
    .get(id) as HabitInstance;
  const entry = db
    .prepare('SELECT * FROM time_entry WHERE id = ?')
    .get(instance.time_entry_id) as TimeEntryRow;
  return { instance, entry };
}

/**
 * Placement headroom for a habit in a local week (#138): the target
 * minus PLANNED + COMPLETE instances whose slot falls in that week.
 * SKIPPED instances do not count — a skip is what frees a slot.
 */
export function habitWeekRemaining(
  db: DB,
  habit: Habit,
  weekStart: string,
): { remaining: number; target: number } {
  const { startIso, endIso } = weekRange(weekStart, habit.timezone || 'UTC');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM habit_instances
        WHERE habit_id = ? AND status IN ('PLANNED', 'COMPLETE')
          AND scheduled_start >= ? AND scheduled_start < ?`,
    )
    .get(habit.id, startIso, endIso) as { n: number };
  const target = weeklyTarget(habit);
  return { remaining: target - row.n, target };
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
 * Move a PLANNED habit instance's linked time_entry anywhere in its
 * local Mon-Sun week (#129; was own-day-only for fixed-days, #118).
 *
 * The week is the load-bearing rule for both habit forms: sliding
 * within it is a move (a Monday 11:00 session done Tuesday 18:00);
 * leaving it is a skip, never a move — skip it and place one in the
 * other week instead (`placeHabitInstance`). The week is computed in
 * the habit's timezone (#146).
 *
 * `habit_instances.scheduled_start` is the immutable slot identity
 * (regeneration dedupes on its local date) and is never rewritten; the
 * linked entry's start/end is the display truth. `newEnd` exists for
 * parity with `moveTimeEntry` but a habit's chunk size is its instance
 * duration (non-combinable) — callers normally omit it and the
 * duration is preserved.
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
    const fromWeek = mondayOfDay(localDayOf(new Date(inst.scheduled_start), tz));
    const toWeek = mondayOfDay(localDayOf(new Date(startCanon), tz));
    if (fromWeek !== toWeek) {
      throw new Error(
        `cannot move habit_instance ${id} out of its week (${fromWeek}): leaving the week is a skip, not a move`,
      );
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
  range?: WeekRange,
): { done: number; target: number } {
  const habit = getHabit(db, habitId);
  if (!habit) throw new Error(`habit ${habitId} not found`);
  // The week is local Monday-to-Monday in the habit's *own* timezone
  // (#146): instances are materialized by `generateHabitInstances` in
  // `habits.timezone`, so scoring must bucket by the same clock or a
  // Sunday-evening instance under a differently-zoned category would
  // score in the wrong week. This deliberately departs from the
  // project -> category chain the other envelopes use.
  const { startIso, endIso } = range ?? weekRange(weekStart, habit.timezone || 'UTC');

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM habit_instances
        WHERE habit_id = ? AND status = 'COMPLETE'
          AND scheduled_start >= ? AND scheduled_start < ?`,
    )
    .get(habitId, startIso, endIso) as { n: number };

  return { done: row.n, target: weeklyTarget(habit) };
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

/**
 * Move an entry by its time_entry id, routing habit entries through
 * `moveHabitInstance` so `move_placement` and the GUI placement drag
 * enforce the same week rule as the habit-instance route (#129).
 * Non-habit entries go straight to `moveTimeEntry`.
 */
export function moveEntryRespectingHabit(
  db: DB,
  timeEntryId: number,
  newStart: string,
  opts: { newEnd?: string } = {},
): void {
  const inst = db
    .prepare('SELECT id FROM habit_instances WHERE time_entry_id = ?')
    .get(timeEntryId) as { id: number } | undefined;
  if (inst) {
    moveHabitInstance(db, inst.id, newStart, opts);
    return;
  }
  moveTimeEntry(db, timeEntryId, newStart, { new_end_at: opts.newEnd });
}

/**
 * Future, still-plannable instances of a habit: PLANNED, with a linked
 * entry that is UNCONFIRMED and starts at or after now. This is the set
 * a schedule edit rewrites and a retire removes; anything past, logged,
 * completed or skipped is history and is never touched (#131).
 */
function futurePlanned(
  db: DB,
  habitId: number,
): Array<HabitInstance & { te_start: string; te_end: string }> {
  return db
    .prepare(
      `SELECT hi.*, te.start_at AS te_start, te.end_at AS te_end
         FROM habit_instances hi
         JOIN time_entry te ON te.id = hi.time_entry_id
        WHERE hi.habit_id = ? AND hi.status = 'PLANNED'
          AND te.status = 'UNCONFIRMED' AND te.start_at >= ?
        ORDER BY hi.scheduled_start`,
    )
    .all(habitId, now()) as Array<HabitInstance & { te_start: string; te_end: string }>;
}

function deleteInstances(db: DB, rows: Array<{ id: number; time_entry_id: number | null }>): void {
  const delInst = db.prepare('DELETE FROM habit_instances WHERE id = ?');
  const delEntry = db.prepare(
    "DELETE FROM time_entry WHERE id = ? AND status = 'UNCONFIRMED'",
  );
  for (const r of rows) {
    delInst.run(r.id);
    if (r.time_entry_id != null) delEntry.run(r.time_entry_id);
  }
}

/**
 * Edit a habit and carry the edit into its future (#131). The template
 * is patched (`updateHabit` rules: one frequency form, valid timezone),
 * then future plannable instances (see `futurePlanned`) follow it:
 *  - title / project: their entries' notes and project are rewritten.
 *  - duration: their entries are resized from their current start.
 *  - start_time / timezone, frequency unchanged: instances still on
 *    their generated slot move to the new time on the same local date
 *    (slot identity follows, so regeneration stays deduped); moved or
 *    placed instances keep the time the user chose.
 *  - frequency (days_of_week / times_per_week): unmoved future
 *    instances are removed and the affected weeks re-materialized under
 *    the new schedule, from today on.
 * Past, confirmed, completed and skipped rows are never touched. One
 * transaction.
 */
export function editHabit(db: DB, id: number, patch: UpdateHabitInput): Habit {
  const tx = db.transaction((): Habit => {
    const before = getHabit(db, id);
    if (!before) throw new Error(`habit ${id} not found`);
    if (!before.active) throw new Error(`habit ${id} is retired; it cannot be edited`);
    if (patch.timezone !== undefined) assertValidTimezone(patch.timezone);
    if (patch.project_id !== undefined) {
      const p = db.prepare('SELECT id FROM projects WHERE id = ?').get(patch.project_id);
      if (!p) throw new Error(`project ${patch.project_id} not found`);
    }
    if (patch.duration_minutes !== undefined &&
        (!Number.isInteger(patch.duration_minutes) || patch.duration_minutes < 1)) {
      throw new Error(`duration_minutes must be a positive integer, got: ${patch.duration_minutes}`);
    }
    // MCP args arrive with absent keys as undefined; `active` is not an
    // edit (retire_habit owns it).
    const rest = Object.fromEntries(
      Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'active'),
    ) as UpdateHabitInput;
    if (Object.keys(rest).length === 0) throw new Error('update_habit needs at least one field to change');
    const after = updateHabit(db, id, rest);

    const oldTz = before.timezone || 'UTC';
    const newTz = after.timezone || 'UTC';
    const freqChanged =
      before.days_of_week !== after.days_of_week ||
      before.times_per_week !== after.times_per_week;
    const timeChanged = before.start_time !== after.start_time || oldTz !== newTz;
    const durMs = after.duration_minutes * 60_000;
    const stamp = now();

    const setEntry = db.prepare(
      `UPDATE time_entry SET start_at = ?, end_at = ?, project_id = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
    );
    const setSlot = db.prepare(
      'UPDATE habit_instances SET scheduled_start = ?, scheduled_end = ? WHERE id = ?',
    );

    const future = futurePlanned(db, id);
    const unmoved = future.filter((r) => r.te_start === r.scheduled_start);
    const moved = future.filter((r) => r.te_start !== r.scheduled_start);

    let regenTo: string | null = null;
    if (freqChanged) {
      for (const r of unmoved) {
        const day = localDayOf(new Date(r.scheduled_start), oldTz);
        if (regenTo === null || day > regenTo) regenTo = day;
      }
      deleteInstances(db, unmoved);
    } else {
      for (const r of unmoved) {
        let start = r.scheduled_start;
        if (timeChanged) {
          const day = localDayOf(new Date(r.scheduled_start), oldTz);
          const [hh, mm] = after.start_time.split(':').map(Number);
          start = new Date(zonedTimeToUtcMs(day, `${pad2(hh)}:${pad2(mm)}`, newTz)).toISOString();
          start = toCanonicalUtc(start, 'scheduled_start');
        }
        const end = toCanonicalUtc(new Date(new Date(start).getTime() + durMs).toISOString(), 'scheduled_end');
        if (start !== r.scheduled_start) {
          const clash = db
            .prepare('SELECT id FROM habit_instances WHERE habit_id = ? AND scheduled_start = ? AND id != ?')
            .get(id, start, r.id) as { id: number } | undefined;
          if (clash) {
            throw new Error(
              `habit ${id}: moving habit_instance ${r.id} to ${start} collides with habit_instance ${clash.id}`,
            );
          }
        }
        setSlot.run(start, end, r.id);
        setEntry.run(start, end, after.project_id, after.title, stamp, r.time_entry_id);
      }
    }
    for (const r of moved) {
      const end = toCanonicalUtc(new Date(new Date(r.te_start).getTime() + durMs).toISOString(), 'end_at');
      setEntry.run(r.te_start, end, after.project_id, after.title, stamp, r.time_entry_id);
    }

    if (freqChanged) {
      const today = localDayOf(new Date(stamp), newTz);
      const through = addDays(mondayOfDay(regenTo !== null && regenTo > today ? regenTo : today), 6);
      generateHabitInstances(db, id, today, through);
    }
    return after;
  });
  return tx();
}

/**
 * Retire a habit (#131): `active = 0`, and its future plannable
 * instances (see `futurePlanned`) are removed with their entries.
 * COMPLETE / SKIPPED instances, past PLANNED ones still awaiting
 * review, and every confirmed entry stay — retiring ends the habit,
 * it never erases what happened. A retired habit generates nothing,
 * cannot be placed or edited, and refuses new assignments.
 */
export function retireHabit(
  db: DB,
  id: number,
): { habit: Habit; removed_instances: number } {
  const tx = db.transaction(() => {
    const habit = getHabit(db, id);
    if (!habit) throw new Error(`habit ${id} not found`);
    if (!habit.active) throw new Error(`habit ${id} is already retired`);
    deactivateHabit(db, id);
    const future = futurePlanned(db, id);
    deleteInstances(db, future);
    return { habit: getHabit(db, id) as Habit, removed_instances: future.length };
  });
  return tx();
}

/**
 * Hard-delete a habit with no history (#131) — the duplicate-habit
 * case. Refuses, writing nothing, when the habit has any COMPLETE
 * instance, any confirmed linked entry, or any envelope pull logged
 * against it; those habits are retired (`retireHabit`), never erased.
 * Otherwise removes the template, every instance, their (unconfirmed)
 * entries, and its assignment rows.
 */
export function deleteHabit(
  db: DB,
  id: number,
): { deleted_habit: number; deleted_instances: number; deleted_entries: number } {
  const tx = db.transaction(() => {
    const habit = getHabit(db, id);
    if (!habit) throw new Error(`habit ${id} not found`);
    const history = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM habit_instances WHERE habit_id = ? AND status = 'COMPLETE') AS complete,
           (SELECT COUNT(*) FROM habit_instances hi JOIN time_entry te ON te.id = hi.time_entry_id
             WHERE hi.habit_id = ? AND te.status = 'CONFIRMED') AS confirmed,
           (SELECT COUNT(*) FROM envelope_moves
             WHERE (from_type = 'habit' AND from_id = ?) OR (to_type = 'habit' AND to_id = ?)) AS moves`,
      )
      .get(id, id, String(id), String(id)) as { complete: number; confirmed: number; moves: number };
    if (history.complete > 0 || history.confirmed > 0 || history.moves > 0) {
      throw new Error(
        `habit ${id} has history (${history.complete} complete, ${history.confirmed} confirmed, ${history.moves} envelope moves); use retire_habit instead`,
      );
    }
    const rows = db
      .prepare('SELECT id, time_entry_id FROM habit_instances WHERE habit_id = ?')
      .all(id) as Array<{ id: number; time_entry_id: number | null }>;
    deleteInstances(db, rows);
    db.prepare("DELETE FROM assignments WHERE envelope_type = 'habit' AND envelope_id = ?").run(String(id));
    db.prepare('DELETE FROM habits WHERE id = ?').run(id);
    return {
      deleted_habit: id,
      deleted_instances: rows.length,
      deleted_entries: rows.filter((r) => r.time_entry_id != null).length,
    };
  });
  return tx();
}
