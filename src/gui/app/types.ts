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
  /** Immutable slot identity (regeneration dedupe) — never moves. */
  scheduled_start: string;
  scheduled_end: string;
  /** SKIPPED instances stay in the payload for the weekly meter but
   *  are filtered out of the timeline in buildDays. */
  status: 'PLANNED' | 'COMPLETE' | 'SKIPPED';
  time_entry_id: number | null;
  /** Display truth: linked entry's span, falling back to the slot. */
  start_at: string;
  end_at: string;
  habit_title: string;
  project_id: string;
  habit_duration: number;
  /** Frequency form: null = fixed-days (drag within its own day);
   *  set = N-per-week target (drag anywhere in its week). */
  times_per_week: number | null;
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
  assigned_minutes: number | null;
  confirmed_minutes: number;
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

/** Latest sync_log row, judged against the requested week (#133). */
export interface LastSync {
  synced_at: string;
  window_from: string | null;
  window_to: string | null;
  received: number;
  inserted: number;
  updated: number;
  deleted: number;
  warnings: string[];
  covers_range: boolean;
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
  last_sync: LastSync | null;
}

export interface TasksPayload {
  tasks: Task[];
}

/* ---- Budget view (#106 M2) — mirrors src/gui/budget-data.ts ---- */

export type EnvelopeType = 'project' | 'goal' | 'habit';
export type EnvelopeFunding = 'overspent' | 'underfunded' | 'on_track' | 'snoozed';

export interface BudgetEnvelope {
  envelope_type: EnvelopeType;
  envelope_id: string;
  title: string;
  /** NULL = snoozed (unfunded) for the week. */
  assigned: number | null;
  activity: { confirmed_minutes: number; scheduled_minutes: number };
  /** assigned − (confirmed + scheduled). */
  available: number;
  funding: EnvelopeFunding;
  status_line: string;
  /** Minutes of this week's ask not yet covered; 0 for projects. */
  needed_minutes: number;
  week_score?: { done: number; target: number };
  /** Owning project — the grouping key. */
  project_id: string;
}

export interface EnvelopeMove {
  id: number;
  week_start: string;
  from_type: EnvelopeType | null;
  from_id: string | null;
  to_type: EnvelopeType | null;
  to_id: string | null;
  minutes: number;
  note: string | null;
  created_at: string;
}

export interface EnvelopesPayload {
  week: string;
  envelopes: BudgetEnvelope[];
}

export interface MovesPayload {
  week: string;
  moves: EnvelopeMove[];
}

/** GET /api/supply — mirrors WeekSupply in src/supply.ts. */
export interface SupplyPayload {
  week_start: string;
  total_supply_minutes: number;
  assigned_minutes: number;
  to_be_assigned_minutes: number;
}

/** projectId → display metadata, built from /api/projects. */
export type ProjectMeta = Record<
  string,
  { name: string; color: string; category_id: string }
>;
