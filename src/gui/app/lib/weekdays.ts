/**
 * Week payload → per-day buckets, ported 1:1 from the legacy
 * dashboard's buildDays/filterWeekData.
 *
 * Placements (UNCONFIRMED time_entry rows) are the planned blocks.
 * task.due never positions a block — it's a pure deadline (#79):
 * unplaced tasks with a due date in the week surface as deadline
 * markers only.
 */
import type {
  CalendarEvent,
  HabitInstance,
  Placement,
  ProjectMeta,
  Task,
  TimeLog,
  WeekPayload,
} from '../types';
import { addDays } from './dates';

export interface DayBucket {
  date: string;
  placed: Placement[];
  deadlines: Task[];
  habits: HabitInstance[];
  logs: TimeLog[];
  meetings: CalendarEvent[];
  totalMin: number;
}

export function buildDays(data: WeekPayload, weekStart: string): DayBucket[] {
  const days: DayBucket[] = [];
  for (let i = 0; i < 7; i++) {
    days.push({
      date: addDays(weekStart, i),
      placed: [],
      deadlines: [],
      habits: [],
      logs: [],
      meetings: [],
      totalMin: 0,
    });
  }
  for (const p of data.placements ?? []) {
    const day = days.find((d) => d.date === p.start_at.slice(0, 10));
    if (day) {
      day.placed.push(p);
      day.totalMin += p.duration_minutes || 0;
    }
  }
  const placedTaskIds = new Set((data.placements ?? []).map((p) => p.task_id));
  for (const t of data.tasks) {
    if (!t.due || t.status === 'ARCHIVED' || placedTaskIds.has(t.id)) continue;
    const day = days.find((d) => d.date === t.due!.slice(0, 10));
    if (day) day.deadlines.push(t);
  }
  for (const hi of data.habit_instances) {
    const day = days.find((d) => d.date === hi.scheduled_start.slice(0, 10));
    if (day) {
      day.habits.push(hi);
      day.totalMin += hi.habit_duration || 0;
    }
  }
  for (const tl of data.time_logs) {
    const day = days.find((d) => d.date === tl.started_at.slice(0, 10));
    if (day && tl.duration_minutes) day.logs.push(tl);
  }
  for (const ce of data.calendar_events ?? []) {
    const day = days.find((d) => d.date === ce.start.slice(0, 10));
    if (day) {
      day.meetings.push(ce);
      day.totalMin += ce.duration_minutes || 0;
    }
  }
  return days;
}

/**
 * Filter the /api/week payload down to the active category view.
 * Server returns everything; the client drops what shouldn't be
 * visible. "work" is the screen-share-safe default; unassigned
 * (`!project_id`) items always show.
 */
export function filterWeekData(
  data: WeekPayload,
  categoryView: string,
  meta: ProjectMeta,
): WeekPayload {
  if (categoryView === 'all') return data;
  const visible = (projectId: string | null | undefined) => {
    if (!projectId) return true; // unassigned — always show
    return (meta[projectId]?.category_id ?? 'work') === categoryView;
  };
  return {
    ...data,
    tasks: data.tasks.filter((t) => visible(t.project_id)),
    habit_instances: data.habit_instances.filter((h) => visible(h.project_id)),
    placements: (data.placements ?? []).filter((p) => visible(p.project_id)),
    time_logs: data.time_logs.filter((tl) => visible(tl.project_id)),
    calendar_events: (data.calendar_events ?? []).filter((ce) => visible(ce.project_id)),
    budgets: data.budgets.filter((b) => visible(b.project_id)),
  };
}

/**
 * "Needs review" cues: a gcal-sync event or placement whose start has
 * passed while still UNCONFIRMED. The fix is in MCP
 * (/calendrome:today); the GUI just flags.
 */
export function isOverdueEvent(ce: CalendarEvent): boolean {
  return ce.status === 'UNCONFIRMED' && Date.parse(ce.start) < Date.now();
}

export function isOverduePlacement(p: Placement): boolean {
  return p.status === 'UNCONFIRMED' && Date.parse(p.start_at) < Date.now();
}
