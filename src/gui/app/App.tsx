import { useEffect, useMemo, useState } from 'react';
import { useWeekData } from './hooks/useWeekData';
import { useTasksData } from './hooks/useTasksData';
import { buildDays, filterWeekData } from './lib/weekdays';
import { addDays, fmtDate, getMonday } from './lib/dates';
import { BudgetCards } from './components/BudgetCards';
import { CompactGrid } from './components/CompactGrid';
import { WeekTimeline } from './components/WeekTimeline';
import { TaskPanel } from './components/TaskPanel';
import { TasksPage } from './components/TasksPage';

type Route = 'week' | 'tasks';
type ViewMode = 'compact' | 'timeline';

function useHashRoute(): Route {
  const read = () => (window.location.hash.startsWith('#/tasks') ? 'tasks' : 'week');
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

/** localStorage-backed preference — keys preserved from the legacy dashboard. */
function usePref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(
    () => (localStorage.getItem(key) as T) || fallback,
  );
  return [
    value,
    (v: T) => {
      localStorage.setItem(key, v);
      setValue(v);
    },
  ];
}

export default function App() {
  const route = useHashRoute();
  const [viewMode, setViewMode] = usePref<ViewMode>('calendrome-view', 'compact');
  // Default to "work" so casual screen-shares never leak personal stuff.
  const [categoryView, setCategoryView] = usePref<string>(
    'calendrome-category-view',
    'work',
  );
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [panelOpen, setPanelOpen] = useState(false);

  const { data, meta, error } = useWeekData(weekStart);
  const panelTasks = useTasksData();

  const filtered = useMemo(
    () => (data ? filterWeekData(data, categoryView, meta) : null),
    [data, categoryView, meta],
  );
  const days = useMemo(
    () => (filtered ? buildDays(filtered, weekStart) : null),
    [filtered, weekStart],
  );

  return (
    <>
      <header>
        <h1>Calendrome</h1>
        <div className="nav-group">
          {route === 'week' ? (
            <>
              <button className="nav-btn" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">
                ←
              </button>
              <span className="week-label">
                {data ? `${fmtDate(data.start)} – ${fmtDate(data.end)}` : '…'}
              </span>
              <button className="nav-btn" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">
                →
              </button>
              <button className="nav-btn" onClick={() => setWeekStart(getMonday(new Date()))}>
                Today
              </button>
              <span className="nav-sep" />
              <button
                className={`nav-btn${viewMode === 'compact' ? ' active' : ''}`}
                onClick={() => setViewMode('compact')}
              >
                Compact
              </button>
              <button
                className={`nav-btn${viewMode === 'timeline' ? ' active' : ''}`}
                onClick={() => setViewMode('timeline')}
              >
                Timeline
              </button>
              <span className="nav-sep" />
            </>
          ) : (
            <>
              <a className="nav-btn" href="#/">
                ← Week
              </a>
              <span className="nav-sep" />
            </>
          )}
          {/* Work view is the screen-share-safe default. "All" reveals everything. */}
          <button
            className={`nav-btn${categoryView === 'work' ? ' active' : ''}`}
            onClick={() => setCategoryView('work')}
            title="Show only work projects (screen-share safe)"
          >
            Work
          </button>
          <button
            className={`nav-btn${categoryView === 'all' ? ' active' : ''}`}
            onClick={() => setCategoryView('all')}
            title="Show every category"
          >
            All
          </button>
          {route === 'week' && (
            <>
              <span className="nav-sep" />
              <button
                className={`nav-btn${panelOpen ? ' active' : ''}`}
                onClick={() => setPanelOpen(!panelOpen)}
                title="Show pending tasks"
              >
                Tasks
              </button>
            </>
          )}
        </div>
      </header>

      {route === 'tasks' ? (
        <TasksPage categoryView={categoryView} />
      ) : (
        <>
          {error && <div className="empty">Error: {error}</div>}
          {filtered && days && (
            <>
              <BudgetCards budgets={filtered.budgets} meta={meta} />
              {viewMode === 'compact' ? (
                <CompactGrid days={days} meta={meta} />
              ) : (
                <WeekTimeline days={days} meta={meta} />
              )}
            </>
          )}
          {panelOpen && (
            <TaskPanel
              tasks={panelTasks.tasks}
              meta={panelTasks.meta}
              categoryView={categoryView}
              onClose={() => setPanelOpen(false)}
            />
          )}
        </>
      )}
    </>
  );
}
