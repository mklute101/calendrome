import type { DB } from './db/connection.js';
import { projectTimezone } from './categories.js';
import { weekRange, type WeekRange } from './day-range.js';
import { assertMonday } from './goals.js';
import { listProjects } from './projects.js';
import { effectiveProjectAssignment } from './standing-assignments.js';

export interface BudgetStatus {
  project_id: string;
  week_start: string;
  /**
   * Minutes assigned for the week. NULL is either uncapped (no
   * standing row, no week row) or snoozed (`snoozed: true`) — the same
   * NULL `get_envelopes` reports as `assigned`. 0 is a real 0h cap.
   */
  assigned_minutes: number | null;
  confirmed_minutes: number;
  scheduled_minutes: number;
  /**
   * assigned − activity. NULL when uncapped; when snoozed the envelope
   * is unfunded, so it is −activity (matches `get_envelopes`).
   */
  available_minutes: number | null;
  overspent: boolean;
  /**
   * The week was snoozed (`assign_hours` with minutes NULL): unfunded,
   * hours consciously perish. Like the envelope's 'snoozed' funding,
   * a snoozed week is never "overspent".
   */
  snoozed: boolean;
}

/**
 * The week `getProjectBudget` rolls up: local Monday-to-Monday in the
 * project's category timezone (#146). Exported so the parity test can
 * assert budgets, envelopes and supply bound the same instants.
 */
export function budgetWeekRange(db: DB, projectId: string, weekStart: string): WeekRange {
  return weekRange(weekStart, projectTimezone(db, projectId));
}

/**
 * Per-project weekly envelope rollup — the project-cap row of
 * `get_envelopes`, read for one project. Reads from `time_entry`:
 *   - CONFIRMED rows in the week range count as `confirmed_minutes`
 *   - UNCONFIRMED rows in the week range count as `scheduled_minutes`
 *
 * Activity follows the envelope attribution rule (#173): entries
 * carrying a `goal_id` count against that goal's envelope, and habit
 * entries against the habit's, never also against the project cap.
 * Otherwise pulling hours from a project into one of its own goals
 * would count the goal block twice (once as goal activity, once as
 * project activity against the reduced cap).
 *
 * `assigned_minutes` is the assignment in force for the week (#173):
 * the week's explicit `assignments` row if one exists (an
 * `assign_hours` / `pull_hours` write), else the project's standing
 * row, else NULL (uncapped) — resolved by `effectiveProjectAssignment`,
 * the one resolution envelopes and pulls also use. `week_start` must
 * be a Monday, as for `get_envelopes`.
 *
 * Minute totals prefer `actual_minutes` when present, falling back to
 * the wall-clock span between `start_at` and `end_at`. This mirrors the
 * `v_task_time_spent` view's accounting and the timesheet exporter.
 */
export function getProjectBudget(
  db: DB,
  projectId: string,
  weekStart: string,
): BudgetStatus {
  assertMonday(weekStart);
  const { startIso, endIso } = budgetWeekRange(db, projectId, weekStart);

  const effective = effectiveProjectAssignment(db, projectId, weekStart);
  const snoozed = effective.snoozed;
  const assigned = effective.minutes;

  const minutesExpr = `COALESCE(
    te.actual_minutes,
    CAST(ROUND((julianday(te.end_at) - julianday(te.start_at)) * 24 * 60) AS INTEGER)
  )`;

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN te.status = 'CONFIRMED'   THEN ${minutesExpr} ELSE 0 END), 0) AS confirmed,
         COALESCE(SUM(CASE WHEN te.status = 'UNCONFIRMED' THEN ${minutesExpr} ELSE 0 END), 0) AS scheduled
         FROM time_entry te
        WHERE te.project_id = ?
          AND te.goal_id IS NULL
          AND te.source != 'habit'
          AND te.start_at >= ?
          AND te.start_at < ?`,
    )
    .get(projectId, startIso, endIso) as { confirmed: number; scheduled: number };

  const confirmed_minutes = Math.round(row.confirmed);
  const scheduled_minutes = Math.round(row.scheduled);
  const activity = confirmed_minutes + scheduled_minutes;

  const available_minutes = snoozed
    ? -activity
    : assigned === null
      ? null
      : assigned - activity;
  const overspent = !snoozed && assigned !== null && activity > assigned;

  return {
    project_id: projectId,
    week_start: weekStart,
    assigned_minutes: assigned,
    confirmed_minutes,
    scheduled_minutes,
    available_minutes,
    overspent,
    snoozed,
  };
}

export function getAllBudgets(db: DB, weekStart: string): BudgetStatus[] {
  assertMonday(weekStart);
  const projects = listProjects(db, { active: true });
  return projects.map((p) => getProjectBudget(db, p.id, weekStart));
}
