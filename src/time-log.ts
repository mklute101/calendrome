import type { DB } from './db/connection.js';
import { getTask, setTaskStatus, type Task } from './tasks.js';

export interface TimeLogEntry {
  id: number;
  task_id: number;
  started_at: string;
  stopped_at: string | null;
  duration_minutes: number | null;
  notes?: string | null;
}

export interface LogTimeInput {
  task_id: number;
  started_at: string;
  stopped_at: string;
  notes?: string | null;
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
 * Insert a closed `time_log` row for work that already happened.
 *
 * Used by the `log_time` MCP tool. The retro counterpart to `stopTask`,
 * which closes a live-timer row started by `startTask`. Both bump
 * `tasks.time_spent_minutes` by the computed duration; neither changes
 * `tasks.status` (a logged hour doesn't imply the task is done — the
 * user calls `complete_task` separately if it is).
 *
 * Validation:
 *   - both timestamps parse as ISO 8601
 *   - `stopped_at` strictly greater than `started_at` (zero-duration entries are noise)
 *   - neither timestamp more than 24h in the future
 *   - no overlap with an open timer on the same task
 *     (an open entry runs `[started_at, ∞)`; we overlap if `new.stopped_at > open.started_at`)
 *   - closed entries are NOT checked for overlap — users may amend or reconcile freely
 */
export function logTime(db: DB, input: LogTimeInput): TimeLogEntry {
  const task = getTask(db, input.task_id);
  if (!task) throw new Error(`task ${input.task_id} not found`);

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

  const open = getOpenEntry(db, input.task_id);
  if (open && Date.parse(open.started_at) < stoppedAt.getTime()) {
    throw new Error(
      `task ${input.task_id} has an open timer started at ${open.started_at}; ` +
        `retro entry overlaps it (stop the timer or pick an earlier window)`,
    );
  }

  const durationMinutes = Math.round(
    (stoppedAt.getTime() - startedAt.getTime()) / 60000,
  );

  const result = db
    .prepare(
      `INSERT INTO time_log (task_id, started_at, stopped_at, duration_minutes, notes)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.task_id,
      startedAt.toISOString(),
      stoppedAt.toISOString(),
      durationMinutes,
      input.notes ?? null,
    );

  db.prepare(
    'UPDATE tasks SET time_spent_minutes = time_spent_minutes + ? WHERE id = ?',
  ).run(durationMinutes, input.task_id);

  return db
    .prepare('SELECT * FROM time_log WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as TimeLogEntry;
}

function getOpenEntry(db: DB, taskId: number): TimeLogEntry | null {
  const row = db
    .prepare(
      'SELECT * FROM time_log WHERE task_id = ? AND stopped_at IS NULL LIMIT 1',
    )
    .get(taskId) as TimeLogEntry | undefined;
  return row ?? null;
}

export function startTask(db: DB, taskId: number): TimeLogEntry {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (getOpenEntry(db, taskId)) {
    throw new Error(`task ${taskId} is already running`);
  }
  const startedAt = new Date().toISOString();
  const result = db
    .prepare('INSERT INTO time_log (task_id, started_at) VALUES (?, ?)')
    .run(taskId, startedAt);

  if (task.status !== 'IN_PROGRESS') {
    setTaskStatus(db, taskId, 'IN_PROGRESS');
  }

  return db
    .prepare('SELECT * FROM time_log WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as TimeLogEntry;
}

export function stopTask(db: DB, taskId: number): TimeLogEntry {
  const open = getOpenEntry(db, taskId);
  if (!open) throw new Error(`task ${taskId} is not running`);

  const stoppedAt = new Date();
  const startedAt = new Date(open.started_at);
  const durationMinutes = Math.max(
    0,
    Math.round((stoppedAt.getTime() - startedAt.getTime()) / 60000),
  );

  db.prepare(
    'UPDATE time_log SET stopped_at = ?, duration_minutes = ? WHERE id = ?',
  ).run(stoppedAt.toISOString(), durationMinutes, open.id);

  db.prepare(
    'UPDATE tasks SET time_spent_minutes = time_spent_minutes + ? WHERE id = ?',
  ).run(durationMinutes, taskId);

  return db
    .prepare('SELECT * FROM time_log WHERE id = ?')
    .get(open.id) as TimeLogEntry;
}

export function completeTask(db: DB, taskId: number): Task {
  if (getOpenEntry(db, taskId)) {
    stopTask(db, taskId);
  }
  return setTaskStatus(db, taskId, 'COMPLETE');
}
