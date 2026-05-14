import type { DB } from './db/connection.js';
import { getTask, setTaskStatus, type Task } from './tasks.js';
import { insertTimeEntry } from './time-entry.js';

export interface LogTimeInput {
  task_id?: number;
  project_id?: string;
  started_at: string;
  stopped_at: string;
  notes?: string | null;
}

export interface LogTimeResult {
  id: number;
  task_id: number | null;
  project_id: string;
  started_at: string;
  stopped_at: string;
  duration_minutes: number;
  notes: string | null;
}

const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

function parseIso(value: string, label: string): Date {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${label} is not a valid ISO 8601 timestamp: ${value}`);
  }
  return new Date(ms);
}

/**
 * Insert a CONFIRMED `time_entry` row (source='manual') for work that already happened.
 *
 * Used by the `log_time` MCP tool. Either `task_id` or `project_id` must be
 * supplied; if only `task_id` is given, `project_id` is derived from the task.
 * If only `project_id` is given, the row records project-only retro time
 * (`task_id` stays NULL).
 *
 * Validation:
 *   - both timestamps parse as ISO 8601
 *   - `stopped_at` strictly greater than `started_at` (zero-duration entries are noise)
 *   - neither timestamp more than 24h in the future
 *
 * The legacy open-timer overlap check is gone: `logTime` writes to
 * `time_entry` now, while live-timer rows still live in `time_log` (legacy)
 * until that path is migrated. Task time totals come from the
 * `v_task_time_spent` view, so we no longer bump `tasks.time_spent_minutes`.
 */
export function logTime(db: DB, input: LogTimeInput): LogTimeResult {
  if (input.task_id === undefined && input.project_id === undefined) {
    throw new Error('log_time requires either task_id or project_id');
  }

  let projectId: string | null = input.project_id ?? null;
  let taskId: number | null = input.task_id ?? null;

  if (taskId !== null) {
    const task = getTask(db, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (projectId === null) projectId = task.project_id;
  }

  if (!projectId) {
    throw new Error('log_time requires either task_id or project_id');
  }

  const startedAt = parseIso(input.started_at, 'started_at');
  const stoppedAt = parseIso(input.stopped_at, 'stopped_at');

  if (stoppedAt.getTime() <= startedAt.getTime()) {
    throw new Error(
      `stopped_at must be strictly after started_at (got ${input.started_at} → ${input.stopped_at})`,
    );
  }

  const futureCutoff = Date.now() + FUTURE_TOLERANCE_MS;
  if (startedAt.getTime() > futureCutoff || stoppedAt.getTime() > futureCutoff) {
    throw new Error(
      'time_log entries cannot be more than 24h in the future',
    );
  }

  const startIso = startedAt.toISOString();
  const stopIso = stoppedAt.toISOString();
  const durationMinutes = Math.round(
    (stoppedAt.getTime() - startedAt.getTime()) / 60000,
  );
  const notes = input.notes ?? null;

  const id = insertTimeEntry(db, {
    task_id: taskId,
    project_id: projectId,
    start_at: startIso,
    end_at: stopIso,
    actual_minutes: durationMinutes,
    status: 'CONFIRMED',
    confirmed_at: stopIso,
    source: 'manual',
    notes,
  });

  return {
    id,
    task_id: taskId,
    project_id: projectId,
    started_at: startIso,
    stopped_at: stopIso,
    duration_minutes: durationMinutes,
    notes,
  };
}

export function completeTask(db: DB, taskId: number): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  return setTaskStatus(db, taskId, 'COMPLETE');
}
