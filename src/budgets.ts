import type { DB } from './db/connection.js';
import { projectTimezone } from './categories.js';
import { weekRange, type WeekRange } from './day-range.js';
import { listProjects } from './projects.js';
import { effectiveProjectAssignment } from './standing-assignments.js';

export interface BudgetStatus {
  project_id: string;
  week_start: string;
  assigned_minutes: number | null;
  confirmed_minutes: number;
  scheduled_minutes: number;
  available_minutes: number | null;
  overspent: boolean;
  /**
   * The week was snoozed (`assign_hours` with minutes NULL): unfunded,
   * so assigned is 0 and available goes negative with any activity —
   * but, like the envelope's 'snoozed' funding, it is not "overspent".
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
 * Per-project weekly envelope rollup. Reads exclusively from `time_entry`:
 *   - CONFIRMED rows in the week range count as `confirmed_minutes`
 *   - UNCONFIRMED rows in the week range count as `scheduled_minutes`
 *
 * `assigned_minutes` is the assignment in force for the week (#173):
 * the week's explicit `assignments` row if one exists (an
 * `assign_hours` / `pull_hours` write), else the project's standing
 * row, else NULL (uncapped) — the same resolution `get_envelopes`
 * uses, so the two reads can no longer disagree. A snoozed week is 0
 * assigned with `snoozed: true`. `available_minutes` is assigned −
 * activity, matching the envelope nomenclature of `/api/envelopes`.
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
  const { startIso, endIso } = budgetWeekRange(db, projectId, weekStart);

  const effective = effectiveProjectAssignment(db, projectId, weekStart);
  const snoozed = effective.snoozed;
  const assigned = snoozed ? 0 : effective.minutes;

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
          AND te.start_at >= ?
          AND te.start_at < ?`,
    )
    .get(projectId, startIso, endIso) as { confirmed: number; scheduled: number };

  const confirmed_minutes = Math.round(row.confirmed);
  const scheduled_minutes = Math.round(row.scheduled);

  const available_minutes =
    assigned === null ? null : assigned - (confirmed_minutes + scheduled_minutes);
  const overspent =
    !snoozed &&
    assigned !== null &&
    confirmed_minutes + scheduled_minutes > assigned;

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
  const projects = listProjects(db, { active: true });
  return projects.map((p) => getProjectBudget(db, p.id, weekStart));
}
