import type { DB } from './db/connection.js';
import { listProjects } from './projects.js';

export interface BudgetStatus {
  project_id: string;
  week_start: string;
  assigned_minutes: number | null;
  confirmed_minutes: number;
  scheduled_minutes: number;
  available_minutes: number | null;
  overspent: boolean;
}

function weekRange(weekStart: string): { startIso: string; endIso: string } {
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

/**
 * Per-project weekly envelope rollup. Reads exclusively from `time_entry`:
 *   - CONFIRMED rows in the week range count as `confirmed_minutes`
 *   - UNCONFIRMED rows in the week range count as `scheduled_minutes`
 *
 * `assigned_minutes` is the project's standing default assignment
 * (`projects.weekly_budget_minutes` — column name kept for history);
 * `available_minutes` is assigned − activity, matching the envelope
 * nomenclature of `/api/envelopes`.
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
  const { startIso, endIso } = weekRange(weekStart);

  const project = db
    .prepare('SELECT weekly_budget_minutes FROM projects WHERE id = ?')
    .get(projectId) as { weekly_budget_minutes: number | null } | undefined;
  const assigned = project?.weekly_budget_minutes ?? null;

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
          AND te.start_at <= ?`,
    )
    .get(projectId, startIso, endIso) as { confirmed: number; scheduled: number };

  const confirmed_minutes = Math.round(row.confirmed);
  const scheduled_minutes = Math.round(row.scheduled);

  const available_minutes =
    assigned === null ? null : assigned - (confirmed_minutes + scheduled_minutes);
  const overspent =
    assigned !== null && confirmed_minutes + scheduled_minutes > assigned;

  return {
    project_id: projectId,
    week_start: weekStart,
    assigned_minutes: assigned,
    confirmed_minutes,
    scheduled_minutes,
    available_minutes,
    overspent,
  };
}

export function getAllBudgets(db: DB, weekStart: string): BudgetStatus[] {
  const projects = listProjects(db, { active: true });
  return projects.map((p) => getProjectBudget(db, p.id, weekStart));
}
