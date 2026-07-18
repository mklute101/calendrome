/**
 * Typed API layer for the GUI. Reads return payloads; writes throw
 * `ApiError` carrying the server's `{error}` message so callers can
 * surface domain guards ("cannot move a confirmed entry") in toasts.
 *
 * Every operation delegates to a swappable `Backend`. The default is
 * the HTTP backend (fetch against the GUI server's /api routes). The
 * website playground swaps in `local-backend.ts`, which runs the same
 * core functions against an in-browser sql.js database — components
 * never know the difference.
 */
import type {
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

export interface Backend {
  fetchProjects(): Promise<Project[]>;
  fetchWeek(start: string): Promise<WeekPayload>;
  fetchTasks(): Promise<TasksPayload>;
  placeTask(args: {
    task_id: number;
    start: string;
    end?: string;
  }): Promise<{ task: Task; event: { id: string }; time_entry_id: number }>;
  movePlacement(
    id: number,
    args: { start: string; end?: string },
  ): Promise<{ placement: Placement & { start_at: string; end_at: string } }>;
  confirmPlacement(
    id: number,
    args: { actual_minutes?: number; notes?: string },
  ): Promise<{ time_entry: unknown }>;
  skipPlacement(id: number): Promise<{
    deleted: { task_id: number | null; start_at: string; end_at: string };
  }>;
  unplaceTask(id: number): Promise<{
    task: Task;
    was: { start_at: string; end_at: string } | null;
  }>;
  completeTask(id: number): Promise<{ task: Task }>;
  reopenTask(
    id: number,
    status: 'NEW' | 'SCHEDULED' | 'IN_PROGRESS',
  ): Promise<{ task: Task }>;
  snoozeTask(id: number, until: string | null): Promise<{ task: Task }>;
}

// ---- default backend: HTTP fetch against the GUI server ----

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

const httpBackend: Backend = {
  fetchProjects: () => request<Project[]>('/api/projects'),
  fetchWeek: (start) => request<WeekPayload>(`/api/week?start=${start}`),
  fetchTasks: () => request<TasksPayload>('/api/tasks'),
  placeTask: (args) => post('/api/placements', args),
  movePlacement: (id, args) => post(`/api/placements/${id}/move`, args),
  confirmPlacement: (id, args) => post(`/api/placements/${id}/confirm`, args),
  skipPlacement: (id) => post(`/api/placements/${id}/skip`),
  unplaceTask: (id) => post(`/api/tasks/${id}/unplace`),
  completeTask: (id) => post(`/api/tasks/${id}/complete`),
  reopenTask: (id, status) => post(`/api/tasks/${id}/reopen`, { status }),
  snoozeTask: (id, until) => post(`/api/tasks/${id}/snooze`, { until }),
};

let backend: Backend = httpBackend;

/** Swap the backend (playground mode). Call before rendering <App/>. */
export function setBackend(b: Backend): void {
  backend = b;
}

// ---- reads ----

export const fetchProjects = () => backend.fetchProjects();
export const fetchWeek = (start: string) => backend.fetchWeek(start);
export const fetchTasks = () => backend.fetchTasks();

// ---- writes ----

export const placeTask = (args: { task_id: number; start: string; end?: string }) =>
  backend.placeTask(args);

export const movePlacement = (id: number, args: { start: string; end?: string }) =>
  backend.movePlacement(id, args);

export const confirmPlacement = (
  id: number,
  args: { actual_minutes?: number; notes?: string } = {},
) => backend.confirmPlacement(id, args);

export const skipPlacement = (id: number) => backend.skipPlacement(id);

export const unplaceTask = (id: number) => backend.unplaceTask(id);

export const completeTask = (id: number) => backend.completeTask(id);

export const reopenTask = (id: number, status: 'NEW' | 'SCHEDULED' | 'IN_PROGRESS') =>
  backend.reopenTask(id, status);

export const snoozeTask = (id: number, until: string | null) =>
  backend.snoozeTask(id, until);
