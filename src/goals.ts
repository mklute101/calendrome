/**
 * Goals — the bucket-of-hours commitment type (#106 prototype).
 *
 * A goal is a target of minutes poured into a project, in one of two
 * flavors (exactly one must be set):
 *
 *   - by-date (`due` set): "600 minutes of prospecting before Sept 12".
 *     The weekly ask is remaining ÷ weeks left, re-paced as reality
 *     happens — fall behind and the ask grows.
 *   - recurring refill (`refill_period` set, 'week' in v1): "180
 *     minutes of Spanish per week, forever". The envelope refills each
 *     week; unspent hours perish.
 *
 * Activity against a goal is ordinary `time_entry` rows carrying a
 * `goal_id` — CONFIRMED rows fill the bucket, UNCONFIRMED rows are
 * scheduled intent. Minutes prefer `actual_minutes`, falling back to
 * the wall-clock span (the `v_task_time_spent` idiom).
 */
import type { DB } from './db/connection.js';

export interface Goal {
  id: number;
  project_id: string;
  title: string;
  notes: string | null;
  target_minutes: number;
  due: string | null;
  refill_period: string | null;
  min_chunk_minutes: number | null;
  active: number;
  created_at: string;
}

export interface CreateGoalInput {
  project_id: string;
  title: string;
  notes?: string | null;
  target_minutes: number;
  due?: string | null;
  refill_period?: string | null;
  min_chunk_minutes?: number | null;
}

export interface UpdateGoalInput {
  title?: string;
  notes?: string | null;
  target_minutes?: number;
  due?: string | null;
  refill_period?: string | null;
  min_chunk_minutes?: number | null;
  active?: number;
}

export interface GoalProgress {
  goal_id: number;
  week_start: string;
  flavor: 'by_date' | 'refill';
  target_minutes: number;
  /** All-time CONFIRMED minutes with this goal_id. */
  confirmed_minutes: number;
  /** All-time UNCONFIRMED minutes with this goal_id. */
  scheduled_minutes: number;
  /** CONFIRMED minutes inside the given week. */
  week_confirmed: number;
  /** UNCONFIRMED minutes inside the given week. */
  week_scheduled: number;
  /** by-date only: target − all-time confirmed, floored at 0. */
  remaining_minutes: number | null;
  /** by-date only: whole weeks from week_start to due, min 1. */
  weeks_left: number | null;
  /** This week's ask: refill = target; by-date = ceil(remaining / weeks_left). */
  weekly_ask: number;
  /** max(0, weekly_ask − week_confirmed − week_scheduled). */
  needed_this_week: number;
  status: 'on_track' | 'behind' | 'funded' | 'complete';
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throw unless `weekStart` is a Monday ISO date (YYYY-MM-DD). */
export function assertMonday(weekStart: string, label = 'week_start'): void {
  if (!PLAIN_DATE.test(weekStart)) {
    throw new Error(`${label} must be a plain ISO date (YYYY-MM-DD), got: ${weekStart}`);
  }
  const dow = new Date(`${weekStart}T00:00:00Z`).getUTCDay();
  if (Number.isNaN(dow)) {
    throw new Error(`${label} is not a valid date: ${weekStart}`);
  }
  if (dow !== 1) {
    throw new Error(`${label} must be a Monday, got ${weekStart} (day ${dow})`);
  }
}

/** Monday of the UTC week containing `now` (defaults to today). */
export function currentWeekMonday(now: Date = new Date()): string {
  const dow = now.getUTCDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(now.getTime() + diff * 86_400_000);
  return mon.toISOString().slice(0, 10);
}

/** Inclusive-start/exclusive-end ISO bounds of the week (budgets.ts convention). */
export function weekRange(weekStart: string): { startIso: string; endIso: string } {
  const start = Date.parse(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(start)) {
    throw new Error(`invalid week_start: ${weekStart}`);
  }
  const end = start + 7 * 86_400_000 - 1;
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
  };
}

// Effective minutes of a time_entry: explicit actual_minutes wins,
// otherwise derive from the start/end span (week-data.ts idiom).
const DURATION_SQL = `COALESCE(
  te.actual_minutes,
  CAST(ROUND((julianday(te.end_at) - julianday(te.start_at)) * 24 * 60) AS INTEGER)
)`;

function validateFlavor(due: string | null, refill: string | null): void {
  if ((due === null) === (refill === null)) {
    throw new Error(
      'a goal must have exactly one of due (by-date) or refill_period (refill)',
    );
  }
  if (refill !== null && refill !== 'week') {
    throw new Error(`refill_period must be 'week' (v1), got: ${refill}`);
  }
  if (due !== null && !PLAIN_DATE.test(due)) {
    throw new Error(`due must be a plain ISO date (YYYY-MM-DD), got: ${due}`);
  }
}

export function createGoal(db: DB, input: CreateGoalInput): Goal {
  const due = input.due ?? null;
  const refill = input.refill_period ?? null;
  validateFlavor(due, refill);
  if (!Number.isInteger(input.target_minutes) || input.target_minutes <= 0) {
    throw new Error(`target_minutes must be a positive integer, got: ${input.target_minutes}`);
  }
  const project = db
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(input.project_id);
  if (!project) throw new Error(`project ${input.project_id} not found`);

  const result = db
    .prepare(
      `INSERT INTO goals
         (project_id, title, notes, target_minutes, due, refill_period, min_chunk_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.project_id,
      input.title,
      input.notes ?? null,
      input.target_minutes,
      due,
      refill,
      input.min_chunk_minutes ?? null,
    );
  return getGoal(db, Number(result.lastInsertRowid)) as Goal;
}

export function getGoal(db: DB, id: number): Goal | null {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as
    | Goal
    | undefined;
  return row ?? null;
}

export function listGoals(db: DB, opts: { active?: boolean } = {}): Goal[] {
  if (opts.active === undefined) {
    return db.prepare('SELECT * FROM goals ORDER BY id').all() as Goal[];
  }
  return db
    .prepare('SELECT * FROM goals WHERE active = ? ORDER BY id')
    .all(opts.active ? 1 : 0) as Goal[];
}

export function updateGoal(db: DB, id: number, patch: UpdateGoalInput): Goal {
  const existing = getGoal(db, id);
  if (!existing) throw new Error(`goal ${id} not found`);

  // Validate the *resulting* flavor, so a patch can flip by-date ↔
  // refill only by setting one side and explicitly nulling the other.
  const due = patch.due !== undefined ? patch.due : existing.due;
  const refill =
    patch.refill_period !== undefined ? patch.refill_period : existing.refill_period;
  validateFlavor(due ?? null, refill ?? null);
  if (patch.target_minutes !== undefined) {
    if (!Number.isInteger(patch.target_minutes) || patch.target_minutes <= 0) {
      throw new Error(`target_minutes must be a positive integer, got: ${patch.target_minutes}`);
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE goals SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  return getGoal(db, id) as Goal;
}

export function deactivateGoal(db: DB, id: number): void {
  const existing = getGoal(db, id);
  if (!existing) throw new Error(`goal ${id} not found`);
  db.prepare('UPDATE goals SET active = 0 WHERE id = ?').run(id);
}

/**
 * Progress + weekly ask for a goal relative to a week.
 *
 * Status derivation (kept deliberately simple for the prototype):
 *   - complete: the bucket is full — by-date: all-time confirmed ≥
 *     target; refill: this week's confirmed ≥ the weekly ask.
 *   - behind:   by-date only — the due date is before week_start and
 *     the bucket didn't fill. (Mid-week pace tracking would need a
 *     clock; out of scope.)
 *   - funded:   this week's ask is fully covered by confirmed +
 *     scheduled minutes (needed_this_week === 0).
 *   - on_track: otherwise — there's still an ask and still time.
 */
export function goalProgress(db: DB, goalId: number, weekStart: string): GoalProgress {
  const goal = getGoal(db, goalId);
  if (!goal) throw new Error(`goal ${goalId} not found`);
  assertMonday(weekStart);
  const { startIso, endIso } = weekRange(weekStart);

  const allTime = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN te.status = 'CONFIRMED'   THEN ${DURATION_SQL} ELSE 0 END), 0) AS confirmed,
         COALESCE(SUM(CASE WHEN te.status = 'UNCONFIRMED' THEN ${DURATION_SQL} ELSE 0 END), 0) AS scheduled
       FROM time_entry te WHERE te.goal_id = ?`,
    )
    .get(goalId) as { confirmed: number; scheduled: number };
  const week = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN te.status = 'CONFIRMED'   THEN ${DURATION_SQL} ELSE 0 END), 0) AS confirmed,
         COALESCE(SUM(CASE WHEN te.status = 'UNCONFIRMED' THEN ${DURATION_SQL} ELSE 0 END), 0) AS scheduled
       FROM time_entry te
       WHERE te.goal_id = ? AND te.start_at >= ? AND te.start_at <= ?`,
    )
    .get(goalId, startIso, endIso) as { confirmed: number; scheduled: number };

  const confirmed_minutes = Math.round(allTime.confirmed);
  const scheduled_minutes = Math.round(allTime.scheduled);
  const week_confirmed = Math.round(week.confirmed);
  const week_scheduled = Math.round(week.scheduled);

  const flavor: GoalProgress['flavor'] = goal.due !== null ? 'by_date' : 'refill';

  let remaining_minutes: number | null = null;
  let weeks_left: number | null = null;
  let weekly_ask: number;
  if (flavor === 'by_date') {
    remaining_minutes = Math.max(0, goal.target_minutes - confirmed_minutes);
    const days =
      (Date.parse(`${goal.due}T00:00:00Z`) - Date.parse(`${weekStart}T00:00:00Z`)) /
      86_400_000;
    weeks_left = Math.max(1, Math.ceil(days / 7));
    weekly_ask = Math.ceil(remaining_minutes / weeks_left);
  } else {
    weekly_ask = goal.target_minutes;
  }

  const needed_this_week = Math.max(0, weekly_ask - week_confirmed - week_scheduled);

  let status: GoalProgress['status'];
  const duePassed = flavor === 'by_date' && (goal.due as string) < weekStart;
  if (flavor === 'by_date' ? confirmed_minutes >= goal.target_minutes : week_confirmed >= weekly_ask) {
    status = 'complete';
  } else if (duePassed) {
    status = 'behind';
  } else if (needed_this_week === 0) {
    status = 'funded';
  } else {
    status = 'on_track';
  }

  return {
    goal_id: goalId,
    week_start: weekStart,
    flavor,
    target_minutes: goal.target_minutes,
    confirmed_minutes,
    scheduled_minutes,
    week_confirmed,
    week_scheduled,
    remaining_minutes,
    weeks_left,
    weekly_ask,
    needed_this_week,
    status,
  };
}
