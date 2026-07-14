import { useMemo, useState } from 'react';
import { useTasksData } from '../hooks/useTasksData';
import { useTaskActions } from '../hooks/useTaskActions';
import { compareTasks, TaskRow } from './TaskRow';
import { PriorityGroups } from './TaskPanel';

type SortKey = 'priority' | 'due' | 'duration';

/** Full-page tasks view (#/tasks) — port of the legacy tasks.html. */
export function TasksPage({ categoryView }: { categoryView: string }) {
  const { tasks, meta, error, refetch } = useTasksData();
  const actions = useTaskActions(refetch);
  const [tab, setTab] = useState<'priorities' | 'tasks'>('priorities');
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('priority');

  const visible = useMemo(
    () =>
      categoryView === 'all'
        ? tasks
        : tasks.filter(
            (t) => (meta[t.project_id]?.category_id ?? 'work') === categoryView,
          ),
    [tasks, meta, categoryView],
  );

  const list = useMemo(() => {
    let out = visible.slice();
    const q = search.trim().toLowerCase();
    if (q) out = out.filter((t) => `${t.title} ${t.notes ?? ''}`.toLowerCase().includes(q));
    if (projectFilter) out = out.filter((t) => t.project_id === projectFilter);
    if (sort === 'duration') out.sort((a, b) => b.duration_minutes - a.duration_minutes);
    else if (sort === 'due')
      out.sort((a, b) => {
        if (a.due === b.due) return a.id - b.id;
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due < b.due ? -1 : 1;
      });
    else out.sort(compareTasks);
    return out;
  }, [visible, search, projectFilter, sort]);

  const projectIds = useMemo(
    () => [...new Set(visible.map((t) => t.project_id))].sort(),
    [visible],
  );

  return (
    <main className="tasks-main">
      {error && <div className="empty">Error: {error}</div>}
      <div className="tabs">
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
        <div className="controls">
          <input
            type="search"
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">All projects</option>
            {projectIds.map((id) => (
              <option key={id} value={id}>
                {meta[id]?.name ?? id}
              </option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="priority">Sort: priority</option>
            <option value="due">Sort: due</option>
            <option value="duration">Sort: duration</option>
          </select>
        </div>
      )}
      {tab === 'priorities' ? (
        <PriorityGroups tasks={visible.slice().sort(compareTasks)} meta={meta} actions={actions} />
      ) : list.length ? (
        list.map((t) => <TaskRow key={t.id} task={t} meta={meta} actions={actions} />)
      ) : (
        <div className="empty">No matching tasks.</div>
      )}
    </main>
  );
}
