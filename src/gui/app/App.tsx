import { useEffect, useState } from 'react';
import { WeekView } from './components/WeekView';
import { TasksPage } from './components/TasksPage';
import { ToastProvider } from './components/Toasts';

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

  return (
    <ToastProvider>
      {route === 'tasks' ? (
        <>
          <header>
            <h1>Calendrome</h1>
            <div className="nav-group">
              <a className="nav-btn" href="#/">
                ← Week
              </a>
              <span className="nav-sep" />
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
            </div>
          </header>
          <TasksPage categoryView={categoryView} />
        </>
      ) : (
        <WeekView
          viewMode={viewMode}
          setViewMode={setViewMode}
          categoryView={categoryView}
          setCategoryView={setCategoryView}
        />
      )}
    </ToastProvider>
  );
}
