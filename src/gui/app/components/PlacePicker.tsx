import { useEffect, useMemo } from 'react';
import type { Goal, HabitScore, ProjectMeta, Task } from '../types';
import { colorOf } from '../lib/colors';
import { fmtDuration } from '../lib/dates';
import { visibleTasks } from './TaskPanel';

/**
 * Empty-slot placement picker (#138) — the no-drag path onto the
 * grid. Clicking empty timeline space opens this popover at the
 * pointer; picking a task or goal places it at the clicked, snapped
 * slot. Offers exactly the placeable set the panel drags offer:
 * NEW / IN_PROGRESS tasks under the active category filter, the
 * week's goals, and habits still under their weekly target (one more
 * instance, e.g. a skipped Monday made up later in the week).
 */
export function PlacePicker({
  tasks,
  goals,
  habits,
  meta,
  categoryView,
  anchor,
  onPickTask,
  onPickGoal,
  onPickHabit,
  onClose,
}: {
  tasks: Task[];
  goals: Goal[];
  habits: HabitScore[];
  meta: ProjectMeta;
  categoryView: string;
  anchor: { x: number; y: number; dayLabel: string; timeLabel: string };
  onPickTask: (t: Task) => void;
  onPickGoal: (g: Goal) => void;
  onPickHabit: (h: HabitScore) => void;
  onClose: () => void;
}) {
  const placeable = useMemo(
    () =>
      visibleTasks(tasks, meta, categoryView).filter(
        (t) => t.status === 'NEW' || t.status === 'IN_PROGRESS',
      ),
    [tasks, meta, categoryView],
  );
  const openHabits = useMemo(() => habits.filter((h) => h.remaining > 0), [habits]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Clamp so the popover stays on-screen when the click is near an edge.
  const W = 280;
  const MAXH = Math.round(window.innerHeight * 0.5);
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - MAXH - 8));

  return (
    <>
      <div className="place-picker-backdrop" onClick={onClose} />
      <div
        className="place-picker"
        style={{ left, top, width: W, maxHeight: MAXH }}
        role="dialog"
        aria-label="Place at this slot"
      >
        <div className="place-picker-head">
          Place at {anchor.dayLabel} {anchor.timeLabel}
        </div>
        <div className="place-picker-body">
          {placeable.length === 0 && goals.length === 0 && openHabits.length === 0 && (
            <div className="empty">Nothing to place.</div>
          )}
          {placeable.length > 0 && (
            <>
              <div className="place-picker-group">Tasks</div>
              {placeable.map((t) => (
                <button
                  key={`t-${t.id}`}
                  className="place-picker-row"
                  style={{ '--c': colorOf(meta, t.project_id) } as React.CSSProperties}
                  onClick={() => onPickTask(t)}
                >
                  <span className="dot" />
                  <span className="task-title">{t.title}</span>
                  <span className="task-dur">{fmtDuration(t.duration_minutes)}</span>
                </button>
              ))}
            </>
          )}
          {goals.length > 0 && (
            <>
              <div className="place-picker-group">Goals</div>
              {goals.map((g) => (
                <button
                  key={`g-${g.id}`}
                  className="place-picker-row"
                  style={{ '--c': colorOf(meta, g.project_id) } as React.CSSProperties}
                  onClick={() => onPickGoal(g)}
                >
                  <span className="dot" />
                  <span className="task-title">{g.title}</span>
                  <span className="task-dur">
                    {fmtDuration(g.min_chunk_minutes ?? 60)}
                  </span>
                </button>
              ))}
            </>
          )}
          {openHabits.length > 0 && (
            <>
              <div className="place-picker-group">Habits</div>
              {openHabits.map((h) => (
                <button
                  key={`h-${h.habit_id}`}
                  className="place-picker-row"
                  style={{ '--c': colorOf(meta, h.project_id) } as React.CSSProperties}
                  onClick={() => onPickHabit(h)}
                >
                  <span className="dot" />
                  <span className="task-title">{h.title}</span>
                  <span className="task-dur">{h.remaining} left</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}
