import { useCallback, useMemo, useState } from 'react';
import * as api from '../api';
import type { Placement, Task } from '../types';
import { useWeekData } from '../hooks/useWeekData';
import { useTasksData } from '../hooks/useTasksData';
import { usePolling } from '../hooks/usePolling';
import { useTaskActions } from '../hooks/useTaskActions';
import {
  useTimelineDrag,
  type DragSource,
  type DropTarget,
} from '../hooks/useTimelineDrag';
import { useToasts } from './Toasts';
import { buildDays, filterWeekData, findOverlap, placementLabel } from '../lib/weekdays';
import { addDays, fmtDate, fmtTime, getMonday } from '../lib/dates';
import { localDateTimeIso } from '../lib/geometry';
import { BudgetCards } from './BudgetCards';
import { CompactGrid } from './CompactGrid';
import { WeekTimeline } from './WeekTimeline';
import { TaskPanel } from './TaskPanel';

type ViewMode = 'compact' | 'timeline';

/**
 * The interactive week view (#24): data, 5s polling, drag
 * move/resize/place with optimistic overlay + undo toasts, and the
 * confirm/skip block actions. Every mutation goes through the write
 * API and ends in a refetch — server truth always wins.
 */
export function WeekView({
  viewMode,
  setViewMode,
  categoryView,
  setCategoryView,
}: {
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  categoryView: string;
  setCategoryView: (v: string) => void;
}) {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [panelOpen, setPanelOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [mutating, setMutating] = useState(false);
  const { show } = useToasts();

  const { data, meta, error, refetch, applyLocal } = useWeekData(weekStart);
  const panelTasks = useTasksData();

  const refetchAll = useCallback(async () => {
    await Promise.all([refetch(), panelTasks.refetch()]);
  }, [refetch, panelTasks.refetch]);

  usePolling(refetchAll, 5000, dragActive || mutating);

  const taskActions = useTaskActions(refetchAll);

  const filtered = useMemo(
    () => (data ? filterWeekData(data, categoryView, meta) : null),
    [data, categoryView, meta],
  );
  const days = useMemo(
    () => (filtered ? buildDays(filtered, weekStart) : null),
    [filtered, weekStart],
  );

  const runMutation = useCallback(
    async (fn: () => Promise<void>) => {
      setMutating(true);
      try {
        await fn();
      } catch (err) {
        show({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        setMutating(false);
        await refetchAll();
      }
    },
    [show, refetchAll],
  );

  const warnOverlap = useCallback(
    (target: DropTarget, excludeEntryId?: number) => {
      if (!days) return;
      const day = days[target.dayIndex];
      const clash = findOverlap(
        day,
        target.startMinutes,
        target.startMinutes + target.durationMinutes,
        excludeEntryId,
      );
      if (clash) {
        show({ kind: 'warn', message: `Overlaps “${clash}” — placed anyway` });
      }
    },
    [days, show],
  );

  const onDrop = useCallback(
    (source: DragSource, target: DropTarget) => {
      if (!days) return;
      const dayDate = days[target.dayIndex].date;
      const startIso = localDateTimeIso(dayDate, target.startMinutes);

      if (source.kind === 'move') {
        const p = source.placement;
        const prior = { start: p.start_at, end: p.end_at };
        const endIso = localDateTimeIso(
          dayDate,
          target.startMinutes + target.durationMinutes,
        );
        // Optimistic: keep the block where it was dropped.
        applyLocal((d) => ({
          ...d,
          placements: d.placements.map((x) =>
            x.time_entry_id === p.time_entry_id
              ? { ...x, start_at: startIso, end_at: endIso }
              : x,
          ),
        }));
        warnOverlap(target, p.time_entry_id);
        void runMutation(async () => {
          await api.movePlacement(p.time_entry_id, { start: startIso });
          show({
            kind: 'info',
            message: `Moved “${placementLabel(p)}” to ${fmtDate(dayDate)} ${fmtTime(startIso)}`,
            undo: async () => {
              await api.movePlacement(p.time_entry_id, {
                start: prior.start,
                end: prior.end,
              });
              await refetchAll();
            },
          });
        });
      } else if (source.kind === 'resize') {
        const p = source.placement;
        const prior = { start: p.start_at, end: p.end_at };
        const day = p.start_at.slice(0, 10);
        // Resize keeps the block's own day + start; only the end moves.
        const startMin = target.startMinutes;
        const endIso = localDateTimeIso(day, startMin + target.durationMinutes);
        applyLocal((d) => ({
          ...d,
          placements: d.placements.map((x) =>
            x.time_entry_id === p.time_entry_id
              ? { ...x, end_at: endIso, duration_minutes: target.durationMinutes }
              : x,
          ),
        }));
        void runMutation(async () => {
          await api.movePlacement(p.time_entry_id, { start: p.start_at, end: endIso });
          show({
            kind: 'info',
            message: `Resized “${placementLabel(p)}” to ${target.durationMinutes} min`,
            undo: async () => {
              await api.movePlacement(p.time_entry_id, {
                start: prior.start,
                end: prior.end,
              });
              await refetchAll();
            },
          });
        });
      } else {
        const task = source.task;
        warnOverlap(target);
        void runMutation(async () => {
          await api.placeTask({ task_id: task.id, start: startIso });
          show({
            kind: 'info',
            message: `Placed “${task.title}” on ${fmtDate(dayDate)} ${fmtTime(startIso)}`,
            undo: async () => {
              await api.unplaceTask(task.id);
              await refetchAll();
            },
          });
        });
      }
    },
    [days, applyLocal, runMutation, warnOverlap, show, refetchAll],
  );

  const { ghost, gridRef, startDrag, dragging } = useTimelineDrag({
    onDrop,
    onDragStateChange: setDragActive,
  });

  const confirmPlacement = useCallback(
    (p: Placement) =>
      runMutation(async () => {
        await api.confirmPlacement(p.time_entry_id);
        show({ kind: 'info', message: `Confirmed “${placementLabel(p)}”` });
      }),
    [runMutation, show],
  );

  const skipPlacement = useCallback(
    (p: Placement) =>
      runMutation(async () => {
        const { deleted } = await api.skipPlacement(p.time_entry_id);
        show({
          kind: 'info',
          message: `Skipped “${placementLabel(p)}”`,
          undo: deleted.task_id
            ? async () => {
                await api.placeTask({
                  task_id: deleted.task_id!,
                  start: deleted.start_at,
                  end: deleted.end_at,
                });
                await refetchAll();
              }
            : undefined,
        });
      }),
    [runMutation, show, refetchAll],
  );

  const startPlaceDrag = useCallback(
    (e: React.PointerEvent, task: Task) => {
      if (viewMode !== 'timeline') return;
      startDrag(e, {
        kind: 'place',
        task,
        color: meta[task.project_id]?.color ?? '#58a6ff',
      });
    },
    [viewMode, startDrag, meta],
  );

  return (
    <>
      <header>
        <h1>Calendrome</h1>
        <div className="nav-group">
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
          <span className="nav-sep" />
          <button
            className={`nav-btn${panelOpen ? ' active' : ''}`}
            onClick={() => setPanelOpen(!panelOpen)}
            title="Show pending tasks"
          >
            Tasks
          </button>
        </div>
      </header>

      {error && <div className="empty">Error: {error}</div>}
      {filtered && days && (
        <>
          <BudgetCards budgets={filtered.budgets} meta={meta} />
          {viewMode === 'compact' ? (
            <CompactGrid days={days} meta={meta} />
          ) : (
            <WeekTimeline
              days={days}
              meta={meta}
              ghost={ghost}
              gridRef={gridRef}
              dragging={dragging}
              onStartDrag={startDrag}
              onConfirm={confirmPlacement}
              onSkip={skipPlacement}
            />
          )}
        </>
      )}
      {panelOpen && (
        <TaskPanel
          tasks={panelTasks.tasks}
          meta={panelTasks.meta}
          categoryView={categoryView}
          onClose={() => setPanelOpen(false)}
          actions={taskActions}
          onDragStart={viewMode === 'timeline' ? startPlaceDrag : undefined}
        />
      )}
    </>
  );
}

