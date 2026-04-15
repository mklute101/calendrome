import type { DB } from './db/connection.js';
import { getTask, setTaskStatus, type Task } from './tasks.js';

export interface TimeLogEntry {
  id: number;
  task_id: number;
  started_at: string;
  stopped_at: string | null;
  duration_minutes: number | null;
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
