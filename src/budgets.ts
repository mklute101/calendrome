import type { DB } from './db/connection.js';
import { listProjects } from './projects.js';

export interface BudgetStatus {
  project_id: string;
  week_start: string;
  allocated_minutes: number | null;
  spent_minutes: number;
  scheduled_minutes: number;
  remaining_minutes: number | null;
  over_budget: boolean;
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
 * Per-project weekly budget rollup. Reads exclusively from `time_entry`:
 *   - CONFIRMED rows in the week range count as `spent_minutes`
 *   - UNCONFIRMED rows in the week range count as `scheduled_minutes`
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
  const allocated = project?.weekly_budget_minutes ?? null;

  const minutesExpr = `COALESCE(
    te.actual_minutes,
    CAST(ROUND((julianday(te.end_at) - julianday(te.start_at)) * 24 * 60) AS INTEGER)
  )`;

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN te.status = 'CONFIRMED'   THEN ${minutesExpr} ELSE 0 END), 0) AS spent,
         COALESCE(SUM(CASE WHEN te.status = 'UNCONFIRMED' THEN ${minutesExpr} ELSE 0 END), 0) AS scheduled
         FROM time_entry te
        WHERE te.project_id = ?
          AND te.start_at >= ?
          AND te.start_at <= ?`,
    )
    .get(projectId, startIso, endIso) as { spent: number; scheduled: number };

  const spent_minutes = Math.round(row.spent);
  const scheduled_minutes = Math.round(row.scheduled);

  const remaining_minutes =
    allocated === null ? null : allocated - (spent_minutes + scheduled_minutes);
  const over_budget =
    allocated !== null && spent_minutes + scheduled_minutes > allocated;

  return {
    project_id: projectId,
    week_start: weekStart,
    allocated_minutes: allocated,
    spent_minutes,
    scheduled_minutes,
    remaining_minutes,
    over_budget,
  };
}

export function getAllBudgets(db: DB, weekStart: string): BudgetStatus[] {
  const projects = listProjects(db, { active: true });
  return projects.map((p) => getProjectBudget(db, p.id, weekStart));
}
