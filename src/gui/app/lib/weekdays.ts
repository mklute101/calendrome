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
  GoalProgress,
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
    // SKIPPED stays in the payload for the weekly meter but never
    // renders (#118). Bucketing uses `start_at` (the linked entry's
    // span — display truth), not the immutable `scheduled_start` slot,
    // so a moved instance lands on its new day.
    if (hi.status === 'SKIPPED') continue;
    const day = days.find((d) => d.date === hi.start_at.slice(0, 10));
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
    goals: (data.goals ?? []).filter((g) => visible(g.project_id)),
    habit_scores: (data.habit_scores ?? []).filter((h) => visible(h.project_id)),
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

/** Same cue for habit instances (#118): started but neither ✓ nor ✕ yet. */
export function isOverdueHabit(hi: HabitInstance): boolean {
  return hi.status === 'PLANNED' && Date.parse(hi.start_at) < Date.now();
}

/**
 * Display label for a placement/logged block: task title when
 * task-linked, goal title for goal blocks (place_goal_block), else
 * untitled. Shared by the timeline, toasts, and the drag ghost so a
 * block never changes name mid-gesture.
 */
export function placementLabel(p: {
  task_title: string | null;
  goal_title?: string | null;
}): string {
  return p.task_title ?? p.goal_title ?? '(untitled)';
}

/**
 * Progress chip text for a goal block: "4.5/10h". By-date goals show
 * the whole bucket (all-time confirmed / target); refill goals reset
 * weekly, so they show this week's confirmed / weekly ask.
 */
export function goalChip(progress: GoalProgress): string {
  const [done, target] =
    progress.flavor === 'by_date'
      ? [progress.confirmed_minutes, progress.target_minutes]
      : [progress.week_confirmed, progress.weekly_ask];
  const h = (m: number) => String(Number((m / 60).toFixed(1)));
  return `${h(done)}/${h(target)}h`;
}

export function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * First block in `day` overlapping [startMin, endMin) — the
 * warn-don't-block check on drop (#24): the drop always completes,
 * the UI just mentions what it collides with.
 */
export function findOverlap(
  day: DayBucket,
  startMin: number,
  endMin: number,
  excludeEntryId?: number,
): string | null {
  const spans: { start: number; end: number; label: string }[] = [];
  for (const p of day.placed) {
    if (p.time_entry_id === excludeEntryId) continue;
    const s = minutesOfDay(p.start_at);
    spans.push({ start: s, end: s + p.duration_minutes, label: p.task_title ?? 'placement' });
  }
  for (const m of day.meetings) {
    const s = minutesOfDay(m.start);
    spans.push({ start: s, end: s + m.duration_minutes, label: m.summary });
  }
  for (const h of day.habits) {
    // A moving habit excludes itself via its linked entry id, same as
    // a moving placement (#118).
    if (h.time_entry_id != null && h.time_entry_id === excludeEntryId) continue;
    const s = minutesOfDay(h.start_at);
    spans.push({ start: s, end: s + (h.habit_duration || 30), label: h.habit_title });
  }
  for (const l of day.logs) {
    const s = minutesOfDay(l.started_at);
    spans.push({ start: s, end: s + l.duration_minutes, label: l.task_title ?? 'logged time' });
  }
  for (const span of spans) {
    if (startMin < span.end && endMin > span.start) return span.label;
  }
  return null;
}
