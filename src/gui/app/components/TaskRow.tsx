import { useEffect, useRef, useState } from 'react';
import type { Priority, ProjectMeta, Task } from '../types';
import { fmtDuration } from '../lib/dates';
import type { TaskActions } from '../hooks/useTaskActions';
import { snoozePresets } from '../hooks/useTaskActions';

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

/**
 * One pending-task row — shared by the drawer and the #/tasks page.
 * With `actions` it grows Complete / Snooze / Unplace buttons (#86);
 * with `onDragStart` a grip appears for drag-to-place onto the
 * timeline. Placing is only offered for NEW / IN_PROGRESS tasks —
 * SCHEDULED already has a block (unplace it first), matching the
 * task-status transition rules.
 */
export function TaskRow({
  task,
  meta,
  actions,
  onDragStart,
}: {
  task: Task;
  meta: ProjectMeta;
  actions?: TaskActions;
  onDragStart?: (e: React.PointerEvent, task: Task) => void;
}) {
  const projectMeta = meta[task.project_id];
  const color = projectMeta?.color || '#58a6ff';
  const projName = projectMeta?.name || task.project_id;
  const due = task.due ? String(task.due).slice(0, 10) : '';
  const snoozed = task.snooze_until ? String(task.snooze_until).slice(0, 10) : '';
  const placeable = task.status === 'NEW' || task.status === 'IN_PROGRESS';

  return (
    <div className="task-row" style={{ '--c': color } as React.CSSProperties}>
      <div className="task-row-main">
        {onDragStart && placeable && (
          <span
            className="task-grip"
            title="Drag onto the timeline to place"
            onPointerDown={(e) => onDragStart(e, task)}
          >
            ⠿
          </span>
        )}
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
        {snoozed && <span className="task-due">zzz {snoozed}</span>}
        {actions && (
          <span className="task-actions">
            <button
              className="task-action"
              title="Mark complete"
              onClick={() => void actions.complete(task)}
            >
              ✓
            </button>
            <SnoozeMenu task={task} actions={actions} />
            {task.status === 'SCHEDULED' && (
              <button
                className="task-action"
                title="Unplace — remove from the calendar"
                onClick={() => void actions.unplace(task)}
              >
                ⏏
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function SnoozeMenu({ task, actions }: { task: Task; actions: TaskActions }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  return (
    <span className="snooze-menu" ref={ref}>
      <button className="task-action" title="Snooze" onClick={() => setOpen(!open)}>
        💤
      </button>
      {open && (
        <span className="snooze-options">
          {snoozePresets().map((p) => (
            <button
              key={p.label}
              className="snooze-option"
              onClick={() => {
                setOpen(false);
                void actions.snooze(task, p.until);
              }}
            >
              {p.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
