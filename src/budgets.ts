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

  const spentRow = db
    .prepare(
      `SELECT COALESCE(SUM(time_log.duration_minutes), 0) AS spent
         FROM time_log
         JOIN tasks ON tasks.id = time_log.task_id
        WHERE tasks.project_id = ?
          AND time_log.started_at >= ?
          AND time_log.started_at <= ?`,
    )
    .get(projectId, startIso, endIso) as { spent: number };

  const habitRow = db
    .prepare(
      `SELECT COALESCE(SUM(
          (julianday(habit_instances.scheduled_end)
           - julianday(habit_instances.scheduled_start)) * 24 * 60
        ), 0) AS scheduled
         FROM habit_instances
         JOIN habits ON habits.id = habit_instances.habit_id
        WHERE habits.project_id = ?
          AND habit_instances.scheduled_start >= ?
          AND habit_instances.scheduled_start <= ?`,
    )
    .get(projectId, startIso, endIso) as { scheduled: number };

  const taskRow = db
    .prepare(
      `SELECT COALESCE(SUM(duration_minutes), 0) AS scheduled
         FROM tasks
        WHERE project_id = ?
          AND calendar_event_id IS NOT NULL
          AND due IS NOT NULL
          AND due >= ?
          AND due <= ?`,
    )
    .get(projectId, startIso, endIso) as { scheduled: number };

  const spent_minutes = Math.round(spentRow.spent);
  const scheduled_minutes = Math.round(habitRow.scheduled + taskRow.scheduled);

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
