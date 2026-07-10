import type { Priority, ProjectMeta, Task } from '../types';
import { fmtDuration } from '../lib/dates';

export const PRIORITY_ORDER: Priority[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const PRIORITY_LABEL: Record<Priority, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};
const PRIORITY_RANK: Record<Priority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};
const STATUS_LABEL: Record<string, string> = {
  NEW: 'New',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
};

export function compareTasks(a: Task, b: Task): number {
  const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pr !== 0) return pr;
  if (a.due !== b.due) {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due < b.due ? -1 : 1;
  }
  return a.id - b.id;
}

/** One pending-task row — shared by the drawer and the #/tasks page. */
export function TaskRow({ task, meta }: { task: Task; meta: ProjectMeta }) {
  const projectMeta = meta[task.project_id];
  const color = projectMeta?.color || '#58a6ff';
  const projName = projectMeta?.name || task.project_id;
  const due = task.due ? String(task.due).slice(0, 10) : '';
  return (
    <div className="task-row" style={{ '--c': color } as React.CSSProperties}>
      <div className="task-row-main">
        <span className="task-title">{task.title}</span>
        <span className="task-dur">{fmtDuration(task.duration_minutes)}</span>
      </div>
      <div className="task-row-meta">
        <span className="task-proj" style={{ '--c': color } as React.CSSProperties}>
          {projName}
        </span>
        <span className={`task-status status-${task.status}`}>
          {STATUS_LABEL[task.status] ?? task.status}
        </span>
        {due && <span className="task-due">due {due}</span>}
      </div>
    </div>
  );
}
