/**
 * Tasks payload assembly for the GUI tasks panel + `/tasks` page (#85).
 *
 * Extracted from the `/api/tasks` route so the payload contract is
 * unit-testable without standing up the Express server, mirroring
 * `week-data.ts`.
 *
 * "Pending / unfinished" means the three live statuses — NEW,
 * IN_PROGRESS, SCHEDULED. COMPLETE and ARCHIVED are excluded: this
 * view is about what still needs attention. Ordering is priority
 * first (CRITICAL → LOW), then earliest due (nulls last), then id for
 * a stable tiebreak.
 */
import type { DB } from '../db/connection.js';
import { listTasks, type Task, type Priority } from '../tasks.js';

const PENDING_STATUSES = new Set(['NEW', 'IN_PROGRESS', 'SCHEDULED']);

const PRIORITY_RANK: Record<Priority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function compareTasks(a: Task, b: Task): number {
  const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pr !== 0) return pr;
  // Earliest due first; tasks with no due sort after those that have one.
  if (a.due !== b.due) {
    if (a.due === null) return 1;
    if (b.due === null) return -1;
    return a.due < b.due ? -1 : 1;
  }
  return a.id - b.id;
}

/**
 * Build the `/api/tasks` JSON payload: every pending/unfinished task,
 * ordered for display.
 */
export function buildTasksPayload(db: DB): { tasks: Task[] } {
  const tasks = listTasks(db)
    .filter((t) => PENDING_STATUSES.has(t.status))
    .sort(compareTasks);
  return { tasks };
}
