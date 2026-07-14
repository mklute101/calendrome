import { useMemo, useState } from 'react';
import type { ProjectMeta, Task } from '../types';
import { compareTasks, PRIORITY_LABEL, PRIORITY_ORDER, TaskRow } from './TaskRow';
import type { TaskActions } from '../hooks/useTaskActions';

/**
 * Pending-tasks drawer (#85). Respects the same Work/All category
 * filter as the week view. Phase 3 adds drag-to-place and action
 * buttons to the rows.
 */
export function TaskPanel({
  tasks,
  meta,
  categoryView,
  onClose,
  actions,
  onDragStart,
}: {
  tasks: Task[];
  meta: ProjectMeta;
  categoryView: string;
  onClose: () => void;
  actions?: TaskActions;
  onDragStart?: (e: React.PointerEvent, task: Task) => void;
}) {
  const [tab, setTab] = useState<'priorities' | 'tasks'>('priorities');
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const base =
      categoryView === 'all'
        ? tasks
        : tasks.filter(
            (t) => (meta[t.project_id]?.category_id ?? 'work') === categoryView,
          );
    return base.slice().sort(compareTasks);
  }, [tasks, meta, categoryView]);

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter((t) =>
      `${t.title} ${t.notes ?? ''}`.toLowerCase().includes(q),
    );
  }, [visible, search]);

  return (
    <aside className="tasks-panel">
      <div className="tasks-panel-head">
        <strong>Pending tasks</strong>
        <span className="spacer" />
        <a className="nav-btn" href="#/tasks" title="Open full-page tasks view">
          ⤢
        </a>
        <button className="nav-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="tasks-panel-tabs">
        <button
          className={`nav-btn${tab === 'priorities' ? ' active' : ''}`}
          onClick={() => setTab('priorities')}
        >
          Priorities
        </button>
        <button
          className={`nav-btn${tab === 'tasks' ? ' active' : ''}`}
          onClick={() => setTab('tasks')}
        >
          Tasks
        </button>
      </div>
      {tab === 'tasks' && (
        <input
          type="search"
          className="tp-search"
          placeholder="Search tasks…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      <div className="tasks-panel-body">
        {tab === 'priorities' ? (
          <PriorityGroups tasks={visible} meta={meta} actions={actions} onDragStart={onDragStart} />
        ) : searched.length ? (
          searched.map((t) => (
            <TaskRow key={t.id} task={t} meta={meta} actions={actions} onDragStart={onDragStart} />
          ))
        ) : (
          <div className="empty">No matching tasks.</div>
        )}
      </div>
    </aside>
  );
}

export function PriorityGroups({
  tasks,
  meta,
  actions,
  onDragStart,
}: {
  tasks: Task[];
  meta: ProjectMeta;
  actions?: TaskActions;
  onDragStart?: (e: React.PointerEvent, task: Task) => void;
}) {
  const groups = PRIORITY_ORDER.map((p) => ({
    priority: p,
    items: tasks.filter((t) => t.priority === p),
  })).filter((g) => g.items.length);
  if (!groups.length) return <div className="empty">No pending tasks.</div>;
  return (
    <>
      {groups.map((g) => (
        <section className="task-group" key={g.priority}>
          <h3 className="task-group-head">
            {PRIORITY_LABEL[g.priority]} <span className="count-badge">{g.items.length}</span>
          </h3>
          {g.items.map((t) => (
            <TaskRow key={t.id} task={t} meta={meta} actions={actions} onDragStart={onDragStart} />
          ))}
        </section>
      ))}
    </>
  );
}
