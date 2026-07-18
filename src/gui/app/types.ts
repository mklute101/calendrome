/**
 * Client-side types mirroring the server payload contracts
 * (`src/gui/week-data.ts`, `src/gui/tasks-data.ts`, `src/tasks.ts`).
 * Hand-written on purpose: the API is the boundary, and these name
 * exactly the fields the app consumes.
 */

export type TaskStatus = 'NEW' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETE' | 'ARCHIVED';
export type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface Task {
  id: number;
  project_id: string;
  title: string;
  notes: string | null;
  priority: Priority;
  status: TaskStatus;
  duration_minutes: number;
  due: string | null;
  snooze_until: string | null;
}

export interface Project {
  id: string;
  name: string;
  prefix: string;
  color: string | null;
  category_id: string | null;
  calendar_id?: string | null;
}

export interface Placement {
  time_entry_id: number;
  task_id: number | null;
  goal_id: number | null;
  start_at: string;
  end_at: string;
  status: 'UNCONFIRMED';
  duration_minutes: number;
  task_title: string | null;
  goal_title: string | null;
  priority: Priority | null;
  project_id: string | null;
}

export interface HabitInstance {
  id: number;
  habit_id: number;
  scheduled_start: string;
  habit_title: string;
  project_id: string;
  habit_duration: number;
}

export interface TimeLog {
  id: number;
  task_id: number | null;
  goal_id: number | null;
  started_at: string;
  stopped_at: string;
  duration_minutes: number;
  notes: string | null;
  task_title: string | null;
  goal_title: string | null;
  project_id: string | null;
}

export interface Budget {
  project_id: string;
  allocated_minutes: number | null;
  spent_minutes: number;
  scheduled_minutes: number;
}

export interface CalendarEvent {
  id: string;
  calendar_id: string;
  project_id: string | null;
  summary: string;
  start: string;
  end: string;
  duration_minutes: number;
  is_meeting: number;
  status: 'UNCONFIRMED' | 'CONFIRMED';
}

export interface AvailabilityOverride {
  id: number;
  start: string;
  end: string;
  available: 0 | 1;
  category_id: string | null;
  reason: string | null;
}

/** `goalProgress` output embedded per goal in the week payload (#106). */
export interface GoalProgress {
  goal_id: number;
  week_start: string;
  flavor: 'by_date' | 'refill';
  target_minutes: number;
  confirmed_minutes: number;
  scheduled_minutes: number;
  week_confirmed: number;
  week_scheduled: number;
  remaining_minutes: number | null;
  weeks_left: number | null;
  weekly_ask: number;
  needed_this_week: number;
  status: 'on_track' | 'behind' | 'funded' | 'complete';
}

export interface Goal {
  id: number;
  project_id: string;
  title: string;
  notes: string | null;
  target_minutes: number;
  due: string | null;
  refill_period: string | null;
  min_chunk_minutes: number | null;
  progress: GoalProgress;
}

/** Weekly frequency meter for a habit: "3/4 this week". */
export interface HabitScore {
  habit_id: number;
  title: string;
  project_id: string;
  done: number;
  target: number;
}

/** Week-level envelope totals — the first ambient budget signal. */
export interface EnvelopeSummary {
  assigned_minutes: number;
  confirmed_minutes: number;
  scheduled_minutes: number;
}

export interface WeekPayload {
  start: string;
  end: string;
  tasks: Task[];
  placements: Placement[];
  habit_instances: HabitInstance[];
  time_logs: TimeLog[];
  budgets: Budget[];
  calendar_events: CalendarEvent[];
  availability: AvailabilityOverride[];
  goals: Goal[];
  habit_scores: HabitScore[];
  envelope_summary: EnvelopeSummary;
}

export interface TasksPayload {
  tasks: Task[];
}

/** projectId → display metadata, built from /api/projects. */
export type ProjectMeta = Record<
  string,
  { name: string; color: string; category_id: string }
>;
