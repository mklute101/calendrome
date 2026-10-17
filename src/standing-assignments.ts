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
 * Resolution for any week W, every reader:
 *   1. an explicit `(project, id, W)` row wins — `minutes` NULL there is
 *      a snooze (unfunded for W);
 *   2. else the standing row's minutes;
 *   3. else no cap (uncapped project, #150) — absence of a standing row,
 *      never a NULL standing row.
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

export interface EffectiveProjectAssignment {
  /** Minutes in force for the week; NULL = uncapped or snoozed. */
  minutes: number | null;
  /** Where the number came from. */
  source: 'week' | 'standing' | 'none';
  /** An explicit NULL row for this week (unfunded, hours perish). */
  snoozed: boolean;
}

/**
 * The assignment in force for a project in a given week — the single
 * resolution every budget reader goes through (see module header).
 */
export function effectiveProjectAssignment(
  db: DB,
  projectId: string,
  weekStart: string,
): EffectiveProjectAssignment {
  const row = db
    .prepare(
      `SELECT minutes FROM assignments
        WHERE envelope_type = 'project' AND envelope_id = ? AND week_start = ?`,
    )
    .get(projectId, weekStart) as { minutes: number | null } | undefined;
  if (row !== undefined) {
    return { minutes: row.minutes, source: 'week', snoozed: row.minutes === null };
  }
  const standing = getStandingProjectMinutes(db, projectId);
  return {
    minutes: standing,
    source: standing === null ? 'none' : 'standing',
    snoozed: false,
  };
}

/**
 * The M5 migration (#173): fold `projects.weekly_budget_minutes` into
 * standing assignment rows, then drop the column. Runs inside one
 * transaction so a failure leaves the column (and every cap) intact.
 * Idempotent: a DB without the column is a no-op. An existing standing
 * row (not possible before this migration, but cheap to respect) wins.
 */
export function foldWeeklyBudgetColumn(db: DB): void {
  const cols = db.prepare(`PRAGMA table_info('projects')`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'weekly_budget_minutes')) return;
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO assignments
         (envelope_type, envelope_id, week_start, minutes, updated_at)
       SELECT 'project', id, ?, weekly_budget_minutes, ?
         FROM projects
        WHERE weekly_budget_minutes IS NOT NULL`,
    ).run(STANDING_WEEK, now());
    db.exec('ALTER TABLE projects DROP COLUMN weekly_budget_minutes');
  })();
}
