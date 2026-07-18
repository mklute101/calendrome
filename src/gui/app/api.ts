/**
 * Typed fetch wrappers for the GUI server API. Reads return payloads;
 * writes throw `ApiError` carrying the server's `{error}` message so
 * callers can surface domain guards ("cannot move a confirmed entry")
 * in toasts.
 */
import type {
  EnvelopeMove,
  EnvelopeType,
  EnvelopesPayload,
  HabitInstance,
  SupplyPayload,
  MovesPayload,
  Placement,
  Project,
  Task,
  TasksPayload,
  WeekPayload,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status line
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---- reads ----

export const fetchProjects = () => request<Project[]>('/api/projects');
export const fetchWeek = (start: string) =>
  request<WeekPayload>(`/api/week?start=${start}`);
export const fetchTasks = () => request<TasksPayload>('/api/tasks');

// ---- writes (phase 3 wires these to the UI) ----

export const placeTask = (args: { task_id: number; start: string; end?: string }) =>
  post<{ task: Task; event: { id: string }; time_entry_id: number }>(
    '/api/placements',
    args,
  );

export const movePlacement = (id: number, args: { start: string; end?: string }) =>
  post<{ placement: Placement & { start_at: string; end_at: string } }>(
    `/api/placements/${id}/move`,
    args,
  );

export const confirmPlacement = (
  id: number,
  args: { actual_minutes?: number; notes?: string } = {},
) => post<{ time_entry: unknown }>(`/api/placements/${id}/confirm`, args);

export const skipPlacement = (id: number) =>
  post<{ deleted: { task_id: number | null; start_at: string; end_at: string } }>(
    `/api/placements/${id}/skip`,
  );

export const unplaceTask = (id: number) =>
  post<{ task: Task; was: { start_at: string; end_at: string } | null }>(
    `/api/tasks/${id}/unplace`,
  );

export const completeTask = (id: number) =>
  post<{ task: Task }>(`/api/tasks/${id}/complete`);

export const reopenTask = (id: number, status: 'NEW' | 'SCHEDULED' | 'IN_PROGRESS') =>
  post<{ task: Task }>(`/api/tasks/${id}/reopen`, { status });

export const snoozeTask = (id: number, until: string | null) =>
  post<{ task: Task }>(`/api/tasks/${id}/snooze`, { until });

// ---- habit instances (#118) ----

export const completeHabitInstance = (id: number) =>
  post<{ instance: HabitInstance }>(`/api/habit-instances/${id}/complete`);

export const skipHabitInstance = (id: number) =>
  post<{ instance: HabitInstance }>(`/api/habit-instances/${id}/skip`);

export const moveHabitInstance = (id: number, args: { start: string; end?: string }) =>
  post<{ instance: HabitInstance; entry: unknown }>(
    `/api/habit-instances/${id}/move`,
    args,
  );

export const reopenHabitInstance = (id: number) =>
  post<{ instance: HabitInstance }>(`/api/habit-instances/${id}/reopen`);

// ---- budget view (#106 M2) ----

export const fetchEnvelopes = (week: string) =>
  request<EnvelopesPayload>(`/api/envelopes?week=${week}`);

export const fetchMoves = (week: string) =>
  request<MovesPayload>(`/api/moves?week=${week}`);

export const fetchSupply = (week: string) =>
  request<SupplyPayload>(`/api/supply?week=${week}`);

// The GUI API says `week` everywhere — GETs and POSTs alike (#120).
// (The MCP surface keeps its `week_start` convention.)

export const assignEnvelope = (args: {
  envelope_type: EnvelopeType;
  envelope_id: string;
  week: string;
  minutes: number | null;
  note?: string;
}) => post<{ assignment: unknown }>('/api/assign', args);

export const pullEnvelope = (args: {
  week: string;
  from?: { type: EnvelopeType; id: string };
  to?: { type: EnvelopeType; id: string };
  minutes: number;
  note?: string;
}) => post<{ move: EnvelopeMove }>('/api/pull', args);
