/**
 * Envelope assignments + pulls (#106 prototype) — YNAB for time.
 *
 * An *envelope* is anything that claims weekly hours: a project (its
 * budget cap), a goal (its weekly ask), or a habit (its frequency
 * ask). The standing config is the default; an `assignments` row is
 * "this week's word" — same standing-vs-this-week split as budget
 * overrides. `minutes NULL` = snoozed (unfunded envelope).
 *
 * The *pull* is the mechanic that matters: moving minutes between two
 * envelopes in the same week is zero-sum and logged to
 * `envelope_moves` (Recent Moves). Either side may be the unassigned
 * supply (NULL).
 *
 * Activity attribution rule (getEnvelopes): every time_entry in the
 * week is counted against exactly one envelope —
 *   - goal envelope:    entries with that goal_id
 *   - habit envelope:   source='habit' entries joined through
 *                       habit_instances.time_entry_id → habit_id
 *   - project envelope: entries with that project_id, no goal_id, and
 *                       source != 'habit' (i.e. what's left after its
 *                       goals and habits claimed theirs)
 * A goal/habit's activity is deliberately NOT double-counted into its
 * project's row; the project row is the "everything else" bucket.
 */
import type { DB } from './db/connection.js';
import {
  assertMonday,
  goalProgress,
  getGoal,
  listGoals,
  weekRange,
} from './goals.js';
import { getHabit, habitWeekScore, listHabits } from './habits.js';
import { listProjects } from './projects.js';

export type EnvelopeType = 'project' | 'goal' | 'habit';

export interface Assignment {
  envelope_type: EnvelopeType;
  envelope_id: string;
  week_start: string;
  minutes: number | null;
  note: string | null;
  updated_at: string;
}

export interface EnvelopeMove {
  id: number;
  week_start: string;
  from_type: string | null;
  from_id: string | null;
  to_type: string | null;
  to_id: string | null;
  minutes: number;
  note: string | null;
  created_at: string;
}

export interface EnvelopeRef {
  type: EnvelopeType;
  id: string;
}

export interface EnvelopeRow {
  envelope_type: EnvelopeType;
  envelope_id: string;
  title: string;
  /** Explicit assignment row if present, else the standing default. NULL = snoozed. */
  assigned: number | null;
  activity: { confirmed_minutes: number; scheduled_minutes: number };
  /** assigned − (confirmed + scheduled); 0-based when snoozed. */
  available: number;
  funding: 'overspent' | 'underfunded' | 'on_track' | 'snoozed';
  status_line: string;
  /**
   * Goal/habit envelopes: minutes of this week's ask not yet covered
   * by activity — the number behind "Nh more needed this week".
   * Always 0 for projects (they have caps, not asks).
   */
  needed_minutes: number;
  /** Habit envelopes only: the weekly frequency meter. */
  week_score?: { done: number; target: number };
}

const ENVELOPE_TYPES: EnvelopeType[] = ['project', 'goal', 'habit'];

function assertEnvelopeExists(db: DB, type: EnvelopeType, id: string): void {
  if (!ENVELOPE_TYPES.includes(type)) {
    throw new Error(`invalid envelope_type: ${type}`);
  }
  let found: unknown;
  if (type === 'project') {
    found = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
  } else if (type === 'goal') {
    found = getGoal(db, Number(id));
  } else {
    found = getHabit(db, Number(id));
  }
  if (!found) throw new Error(`${type} ${id} not found`);
}

/**
 * The standing weekly default for an envelope, used when no
 * assignments row exists: project → its budget cap (0 when unset),
 * goal → its weekly ask, habit → instances-per-week × duration.
 */
export function standingDefault(
  db: DB,
  type: EnvelopeType,
  id: string,
  weekStart: string,
): number {
  if (type === 'project') {
    const row = db
      .prepare('SELECT weekly_budget_minutes FROM projects WHERE id = ?')
      .get(id) as { weekly_budget_minutes: number | null } | undefined;
    return row?.weekly_budget_minutes ?? 0;
  }
  if (type === 'goal') {
    return goalProgress(db, Number(id), weekStart).weekly_ask;
  }
  const habit = getHabit(db, Number(id));
  if (!habit) throw new Error(`habit ${id} not found`);
  const perWeek =
    habit.times_per_week != null
      ? habit.times_per_week
      : habit.days_of_week.split(',').filter((s) => s.trim() !== '').length;
  return perWeek * habit.duration_minutes;
}

export interface AssignHoursInput {
  envelope_type: EnvelopeType;
  envelope_id: string;
  week_start: string;
  /** NULL = snooze the envelope for the week (unfunded). */
  minutes: number | null;
  note?: string | null;
}

export function assignHours(db: DB, input: AssignHoursInput): Assignment {
  assertMonday(input.week_start);
  assertEnvelopeExists(db, input.envelope_type, input.envelope_id);
  if (
    input.minutes !== null &&
    (!Number.isInteger(input.minutes) || input.minutes < 0)
  ) {
    throw new Error(`minutes must be a non-negative integer or null, got: ${input.minutes}`);
  }
  db.prepare(
    `INSERT INTO assignments (envelope_type, envelope_id, week_start, minutes, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(envelope_type, envelope_id, week_start)
     DO UPDATE SET minutes = excluded.minutes,
                   note = excluded.note,
                   updated_at = datetime('now')`,
  ).run(
    input.envelope_type,
    input.envelope_id,
    input.week_start,
    input.minutes,
    input.note ?? null,
  );
  return db
    .prepare(
      `SELECT * FROM assignments
        WHERE envelope_type = ? AND envelope_id = ? AND week_start = ?`,
    )
    .get(input.envelope_type, input.envelope_id, input.week_start) as Assignment;
}

export interface PullHoursInput {
  week_start: string;
  /** Omit for "from unassigned supply". */
  from?: EnvelopeRef | null;
  /** Omit for "released back to supply". */
  to?: EnvelopeRef | null;
  minutes: number;
  note?: string | null;
}

/**
 * Move minutes between two envelopes in a week — the YNAB pull.
 *
 * Missing assignment rows are seeded from the standing default first,
 * so "take 2h from ACME" works even when ACME is still riding its
 * standing cap. A snoozed envelope counts as 0 assigned: pulling from
 * it throws; pulling *into* it re-funds it from 0. Never goes
 * negative — a shortfall throws with the numbers in the message.
 * Every pull logs one envelope_moves row (Recent Moves).
 */
export function pullHours(db: DB, input: PullHoursInput): EnvelopeMove {
  assertMonday(input.week_start);
  if (!Number.isInteger(input.minutes) || input.minutes <= 0) {
    throw new Error(`minutes must be a positive integer, got: ${input.minutes}`);
  }
  const from = input.from ?? null;
  const to = input.to ?? null;
  if (from === null && to === null) {
    throw new Error('pull_hours needs at least one of from/to');
  }
  if (from) assertEnvelopeExists(db, from.type, from.id);
  if (to) assertEnvelopeExists(db, to.type, to.id);

  const getRow = db.prepare(
    `SELECT minutes FROM assignments
      WHERE envelope_type = ? AND envelope_id = ? AND week_start = ?`,
  );
  const setMinutes = db.prepare(
    `INSERT INTO assignments (envelope_type, envelope_id, week_start, minutes)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(envelope_type, envelope_id, week_start)
     DO UPDATE SET minutes = excluded.minutes, updated_at = datetime('now')`,
  );

  // Current assigned minutes, seeding from the standing default when no
  // explicit row exists. Snoozed (explicit NULL) counts as 0.
  const currentAssigned = (ref: EnvelopeRef): number => {
    const row = getRow.get(ref.type, ref.id, input.week_start) as
      | { minutes: number | null }
      | undefined;
    if (row === undefined) {
      return standingDefault(db, ref.type, ref.id, input.week_start);
    }
    return row.minutes ?? 0;
  };

  const pullTx = db.transaction((): EnvelopeMove => {
    if (from) {
      const have = currentAssigned(from);
      if (have < input.minutes) {
        throw new Error(
          `cannot pull ${input.minutes}m from ${from.type} ${from.id}: ` +
            `only ${have}m assigned this week (short ${input.minutes - have}m)`,
        );
      }
      setMinutes.run(from.type, from.id, input.week_start, have - input.minutes);
    }
    if (to) {
      const have = currentAssigned(to);
      setMinutes.run(to.type, to.id, input.week_start, have + input.minutes);
    }
    const result = db
      .prepare(
        `INSERT INTO envelope_moves
           (week_start, from_type, from_id, to_type, to_id, minutes, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.week_start,
        from?.type ?? null,
        from?.id ?? null,
        to?.type ?? null,
        to?.id ?? null,
        input.minutes,
        input.note ?? null,
      );
    return db
      .prepare('SELECT * FROM envelope_moves WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as EnvelopeMove;
  });
  return pullTx();
}

/** Recent Moves for a week, newest first. */
export function listMoves(db: DB, weekStart: string): EnvelopeMove[] {
  assertMonday(weekStart);
  return db
    .prepare('SELECT * FROM envelope_moves WHERE week_start = ? ORDER BY id DESC')
    .all(weekStart) as EnvelopeMove[];
}

const DURATION_SQL = `COALESCE(
  te.actual_minutes,
  CAST(ROUND((julianday(te.end_at) - julianday(te.start_at)) * 24 * 60) AS INTEGER)
)`;

function fmtHours(minutes: number): string {
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

/**
 * The budget-view read: one row per active project, goal, and habit,
 * with assigned / activity / available and a YNAB-style funding
 * status. See the module header for the attribution rule.
 */
export function getEnvelopes(db: DB, weekStart: string): EnvelopeRow[] {
  assertMonday(weekStart);
  const { startIso, endIso } = weekRange(weekStart);

  const assignmentRows = db
    .prepare('SELECT * FROM assignments WHERE week_start = ?')
    .all(weekStart) as Assignment[];
  const explicit = new Map<string, Assignment>(
    assignmentRows.map((a) => [`${a.envelope_type}:${a.envelope_id}`, a]),
  );

  const sums = { confirmed: 'confirmed', scheduled: 'scheduled' };
  const activitySql = `
    COALESCE(SUM(CASE WHEN te.status = 'CONFIRMED'   THEN ${DURATION_SQL} ELSE 0 END), 0) AS ${sums.confirmed},
    COALESCE(SUM(CASE WHEN te.status = 'UNCONFIRMED' THEN ${DURATION_SQL} ELSE 0 END), 0) AS ${sums.scheduled}`;

  const projectActivity = db.prepare(
    `SELECT ${activitySql} FROM time_entry te
      WHERE te.project_id = ? AND te.goal_id IS NULL AND te.source != 'habit'
        AND te.start_at >= ? AND te.start_at <= ?`,
  );
  const goalActivity = db.prepare(
    `SELECT ${activitySql} FROM time_entry te
      WHERE te.goal_id = ?
        AND te.start_at >= ? AND te.start_at <= ?`,
  );
  const habitActivity = db.prepare(
    `SELECT ${activitySql} FROM time_entry te
      JOIN habit_instances hi ON hi.time_entry_id = te.id
      WHERE te.source = 'habit' AND hi.habit_id = ?
        AND te.start_at >= ? AND te.start_at <= ?`,
  );

  const rows: EnvelopeRow[] = [];

  const buildRow = (
    type: EnvelopeType,
    id: string,
    title: string,
    activityRaw: { confirmed: number; scheduled: number },
    weeklyAskNeeded: number | null, // goal/habit "needed" nag; null for projects
    weekScore?: { done: number; target: number },
  ): EnvelopeRow => {
    const key = `${type}:${id}`;
    const explicitRow = explicit.get(key);
    const assigned =
      explicitRow !== undefined
        ? explicitRow.minutes
        : standingDefault(db, type, id, weekStart);
    const confirmed_minutes = Math.round(activityRaw.confirmed);
    const scheduled_minutes = Math.round(activityRaw.scheduled);
    const activityTotal = confirmed_minutes + scheduled_minutes;
    const available = (assigned ?? 0) - activityTotal;

    // Funding, in precedence order:
    //   snoozed     — explicit NULL assignment for the week
    //   overspent   — activity exceeds the assigned minutes
    //   underfunded — (goals/habits) the week's ask isn't covered yet
    //   on_track    — otherwise
    let funding: EnvelopeRow['funding'];
    let status_line: string;
    if (explicitRow !== undefined && explicitRow.minutes === null) {
      funding = 'snoozed';
      status_line = 'Snoozed this week';
    } else if (activityTotal > (assigned ?? 0)) {
      funding = 'overspent';
      status_line = `Overspent: ${fmtHours(activityTotal)} of ${fmtHours(assigned ?? 0)}`;
    } else if (weeklyAskNeeded !== null && weeklyAskNeeded > 0) {
      funding = 'underfunded';
      status_line = `${fmtHours(weeklyAskNeeded)} more needed this week`;
    } else {
      funding = 'on_track';
      status_line = 'On track';
    }

    return {
      envelope_type: type,
      envelope_id: id,
      title,
      assigned,
      activity: { confirmed_minutes, scheduled_minutes },
      available,
      funding,
      status_line,
      needed_minutes: weeklyAskNeeded ?? 0,
      ...(weekScore ? { week_score: weekScore } : {}),
    };
  };

  for (const project of listProjects(db, { active: true })) {
    const activity = projectActivity.get(project.id, startIso, endIso) as {
      confirmed: number;
      scheduled: number;
    };
    rows.push(buildRow('project', project.id, project.name, activity, null));
  }

  for (const goal of listGoals(db, { active: true })) {
    const activity = goalActivity.get(goal.id, startIso, endIso) as {
      confirmed: number;
      scheduled: number;
    };
    const progress = goalProgress(db, goal.id, weekStart);
    rows.push(
      buildRow('goal', String(goal.id), goal.title, activity, progress.needed_this_week),
    );
  }

  for (const habit of listHabits(db, { active: true })) {
    const activity = habitActivity.get(habit.id, startIso, endIso) as {
      confirmed: number;
      scheduled: number;
    };
    const ask = standingDefault(db, 'habit', String(habit.id), weekStart);
    const activityTotal =
      Math.round(activity.confirmed) + Math.round(activity.scheduled);
    const needed = Math.max(0, ask - activityTotal);
    const score = habitWeekScore(db, habit.id, weekStart);
    rows.push(
      buildRow('habit', String(habit.id), habit.title, activity, needed, score),
    );
  }

  return rows;
}
