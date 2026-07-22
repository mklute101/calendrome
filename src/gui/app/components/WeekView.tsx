import { useCallback, useMemo, useState } from 'react';
import * as api from '../api';
import type { Goal, HabitInstance, Placement, Task } from '../types';
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
import { addDays, fmtDate, fmtHours, fmtTime, getMonday } from '../lib/dates';
import { routeWeek, setRouteWeek, weekHref } from '../lib/route';
import { localDateTimeIso } from '../lib/geometry';
import { BudgetCards } from './BudgetCards';
import { CompactGrid } from './CompactGrid';
import { SyncBadge } from './SyncBadge';
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
  // Week comes from the hash route so it survives the trip to the
  // budget view and back (#120); navigation writes it back there.
  const [weekStart, setWeekStart] = useState(
    () => routeWeek() ?? getMonday(new Date()),
  );
  const gotoWeek = useCallback((week: string) => {
    setWeekStart(week);
    setRouteWeek(week);
  }, []);
  const gotoToday = useCallback(() => {
    setWeekStart(getMonday(new Date()));
    setRouteWeek(null); // no param = current week
  }, []);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [mutating, setMutating] = useState(false);
  const { show } = useToasts();

  const { data, meta, error, refetch, applyLocal } = useWeekData(weekStart);
  const panelTasks = useTasksData();

  const refetchAll = useCallback(async () => {
    await Promise.all([refetch(), panelTasks.refetch()]);
  }, [refetch, panelTasks.refetch]);

  usePolling(refetchAll, 2000, dragActive || mutating);

  const taskActions = useTaskActions(refetchAll);

  const filtered = useMemo(
    () => (data ? filterWeekData(data, categoryView, meta) : null),
    [data, categoryView, meta],
  );
  const days = useMemo(
    () => (filtered ? buildDays(filtered, weekStart) : null),
    [filtered, weekStart],
  );
  // Goal lookup for the timeline's progress chips. Built from the
  // unfiltered payload — a goal block already filtered out of `days`
  // simply never asks for its chip.
  const goalsById = useMemo(() => {
    const m: Record<number, Goal> = {};
    for (const g of data?.goals ?? []) m[g.id] = g;
    return m;
  }, [data]);

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
      } else if (source.kind === 'move-habit') {
        // Slide within the frequency range (#118). The ghost already
        // refused out-of-range days; the server re-enforces the rule.
        const hi = source.habit;
        const prior = { start: hi.start_at, end: hi.end_at };
        const endIso = localDateTimeIso(
          dayDate,
          target.startMinutes + target.durationMinutes,
        );
        applyLocal((d) => ({
          ...d,
          habit_instances: d.habit_instances.map((x) =>
            x.id === hi.id ? { ...x, start_at: startIso, end_at: endIso } : x,
          ),
        }));
        warnOverlap(target, hi.time_entry_id ?? undefined);
        void runMutation(async () => {
          await api.moveHabitInstance(hi.id, { start: startIso });
          show({
            kind: 'info',
            message: `Moved “${hi.habit_title}” to ${fmtDate(dayDate)} ${fmtTime(startIso)}`,
            undo: async () => {
              await api.moveHabitInstance(hi.id, { start: prior.start });
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

  // Habit ✓/✕ (#118) mirror confirm/skip; both undo via /reopen — the
  // GUI-only path back to PLANNED (skip deleted the entry, so undo
  // re-inserts it at the scheduled slot server-side).
  const completeHabit = useCallback(
    (hi: HabitInstance) =>
      runMutation(async () => {
        await api.completeHabitInstance(hi.id);
        show({
          kind: 'info',
          message: `Done “${hi.habit_title}”`,
          undo: async () => {
            await api.reopenHabitInstance(hi.id);
            await refetchAll();
          },
        });
      }),
    [runMutation, show, refetchAll],
  );

  const skipHabit = useCallback(
    (hi: HabitInstance) =>
      runMutation(async () => {
        await api.skipHabitInstance(hi.id);
        show({
          kind: 'info',
          message: `Skipped “${hi.habit_title}”`,
          undo: async () => {
            await api.reopenHabitInstance(hi.id);
            await refetchAll();
          },
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
          <button className="nav-btn" onClick={() => gotoWeek(addDays(weekStart, -7))} aria-label="Previous week">
            ←
          </button>
          <span className="week-label">
            {data ? `${fmtDate(data.start)} – ${fmtDate(data.end)}` : '…'}
          </span>
          <button className="nav-btn" onClick={() => gotoWeek(addDays(weekStart, 7))} aria-label="Next week">
            →
          </button>
          <button className="nav-btn" onClick={gotoToday}>
            Today
          </button>
          {data?.envelope_summary && (
            <span
              className="envelope-strip"
              title="This week's envelopes: hours assigned vs hours confirmed"
            >
              assigned {fmtHours(data.envelope_summary.assigned_minutes)} ·{' '}
              confirmed {fmtHours(data.envelope_summary.confirmed_minutes)}
            </span>
          )}
          {data && <SyncBadge lastSync={data.last_sync} />}
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
          <a
            className="nav-btn"
            href={weekHref('#/budget', weekStart)}
            title="Envelope budget view"
          >
            Budget
          </a>
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
            <CompactGrid days={days} meta={meta} goalsById={goalsById} />
          ) : (
            <WeekTimeline
              days={days}
              meta={meta}
              goalsById={goalsById}
              ghost={ghost}
              gridRef={gridRef}
              dragging={dragging}
              onStartDrag={startDrag}
              onConfirm={confirmPlacement}
              onSkip={skipPlacement}
              onCompleteHabit={completeHabit}
              onSkipHabit={skipHabit}
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
          goals={filtered?.goals ?? []}
          habitScores={filtered?.habit_scores ?? []}
        />
      )}
    </>
  );
}

