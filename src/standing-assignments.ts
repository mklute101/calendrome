/**
 * Standing project assignments (#173, spec M5 cutover).
 *
 * A project's weekly cap used to live in `projects.weekly_budget_minutes`
 * while per-week overrides lived in `assignments` — two sources of
 * truth that disagreed whenever a week had an explicit row
 * (`get_project_budget` read the column, `get_envelopes` read the row).
 * The cap now lives in `assignments` too, as one *standing* row per
 * project:
 *
 *   (envelope_type = 'project', envelope_id = <project id>,
 *    week_start = 'standing', minutes = <cap>)
 *
 * Resolution for any envelope (project, goal or habit) and week W,
 * every reader (`resolveAssignment`):
 *   1. an explicit `(type, id, W)` row wins — `minutes` NULL there is
 *      a snooze (unfunded for W);
 *   2. else the envelope's standing row (only projects have one);
 *   3. else 'none': an uncapped project (#150), or for a goal/habit
 *      its derived ask (weekly ask, frequency ask), which the caller
 *      computes (`standingDefault` in src/assignments.ts).
 *
 * Standing rows exist only for project envelopes: goal and habit
 * defaults are derived (weekly ask, frequency ask), not stored.
 * `week_start = 'standing'` can never collide with a real week, and
 * `assign_hours` rejects it (not a Monday), so per-week writes cannot
 * clobber the standing cap. The API keeps the `weekly_budget_minutes`
 * name on create/update/list project — it is the standing row, read
 * and written through this module.
 */
import type { DB } from './db/connection.js';
import { now } from './clock.js';

/** The sentinel `week_start` of a standing assignment row. */
export const STANDING_WEEK = 'standing';

/** The project's standing weekly cap in minutes, or NULL when uncapped. */
export function getStandingProjectMinutes(db: DB, projectId: string): number | null {
  const row = db
    .prepare(
      `SELECT minutes FROM assignments
        WHERE envelope_type = 'project' AND envelope_id = ? AND week_start = ?`,
    )
    .get(projectId, STANDING_WEEK) as { minutes: number | null } | undefined;
  return row?.minutes ?? null;
}

/**
 * Set (or clear, with NULL) a project's standing weekly cap. NULL
 * deletes the standing row: an uncapped project has no row at all.
 */
export function setStandingProjectMinutes(
  db: DB,
  projectId: string,
  minutes: number | null,
): void {
  if (minutes === null) {
    db.prepare(
      `DELETE FROM assignments
        WHERE envelope_type = 'project' AND envelope_id = ? AND week_start = ?`,
    ).run(projectId, STANDING_WEEK);
    return;
  }
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(
      `weekly_budget_minutes must be a non-negative integer or null, got: ${minutes}`,
    );
  }
  db.prepare(
    `INSERT INTO assignments (envelope_type, envelope_id, week_start, minutes, updated_at)
     VALUES ('project', ?, ?, ?, ?)
     ON CONFLICT(envelope_type, envelope_id, week_start)
     DO UPDATE SET minutes = excluded.minutes, updated_at = excluded.updated_at`,
  ).run(projectId, STANDING_WEEK, minutes, now());
}

export type AssignmentSource = 'week' | 'standing' | 'none';

export interface EffectiveAssignment {
  /** Minutes in force for the week; NULL = snoozed, or 'none'. */
  minutes: number | null;
  /** Where the number came from; 'none' = no row applies. */
  source: AssignmentSource;
  /** An explicit NULL row for this week (unfunded, hours perish). */
  snoozed: boolean;
}

/** Every assignment row that can apply to one week: its rows + standing rows. */
export type AssignmentMap = Map<string, { week: number | null | undefined; standing: number | undefined }>;

const key = (type: string, id: string) => `${type}:${id}`;

type Row = { envelope_type: string; envelope_id: string; week_start: string; minutes: number | null };

function toMap(rows: Row[]): AssignmentMap {
  const map: AssignmentMap = new Map();
  for (const r of rows) {
    const k = key(r.envelope_type, r.envelope_id);
    const entry = map.get(k) ?? { week: undefined, standing: undefined };
    if (r.week_start === STANDING_WEEK) {
      if (r.minutes !== null) entry.standing = r.minutes;
    } else {
      entry.week = r.minutes;
    }
    map.set(k, entry);
  }
  return map;
}

/**
 * Load the week's explicit rows and all standing rows in one query
 * (`week_start IN (?, 'standing')`), keyed by envelope. Readers that
 * resolve many envelopes for one week (getEnvelopes, getAllBudgets)
 * load once and resolve from the map.
 */
export function loadAssignments(db: DB, weekStart: string): AssignmentMap {
  return toMap(
    db
      .prepare(
        `SELECT envelope_type, envelope_id, week_start, minutes FROM assignments
          WHERE week_start IN (?, ?)`,
      )
      .all(weekStart, STANDING_WEEK) as Row[],
  );
}

/** The one resolution (see module header), from a loaded map. */
export function resolveAssignment(
  map: AssignmentMap,
  type: string,
  id: string,
): EffectiveAssignment {
  const entry = map.get(key(type, id));
  if (entry !== undefined && entry.week !== undefined) {
    return { minutes: entry.week, source: 'week', snoozed: entry.week === null };
  }
  if (entry !== undefined && entry.standing !== undefined) {
    return { minutes: entry.standing, source: 'standing', snoozed: false };
  }
  return { minutes: null, source: 'none', snoozed: false };
}

/** `resolveAssignment` for one envelope, without a preloaded map. */
export function effectiveAssignment(
  db: DB,
  type: string,
  id: string,
  weekStart: string,
): EffectiveAssignment {
  const rows = db
    .prepare(
      `SELECT envelope_type, envelope_id, week_start, minutes FROM assignments
        WHERE envelope_type = ? AND envelope_id = ? AND week_start IN (?, ?)`,
    )
    .all(type, id, weekStart, STANDING_WEEK) as Row[];
  return resolveAssignment(toMap(rows), type, id);
}
