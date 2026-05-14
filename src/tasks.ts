import type { DB } from './db/connection.js';

export type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type TaskStatus =
  | 'NEW'
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'COMPLETE'
  | 'ARCHIVED';

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
  depends_on: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskInput {
  project_id: string;
  title: string;
  notes?: string | null;
  priority?: Priority;
  duration_minutes?: number;
  due?: string | null;
  snooze_until?: string | null;
  depends_on?: number | null;
}

export interface UpdateTaskInput {
  title?: string;
  notes?: string | null;
  priority?: Priority;
  duration_minutes?: number;
  due?: string | null;
  snooze_until?: string | null;
  depends_on?: number | null;
}

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  NEW: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETE', 'ARCHIVED'],
  SCHEDULED: ['NEW', 'IN_PROGRESS', 'COMPLETE', 'ARCHIVED'],
  IN_PROGRESS: ['SCHEDULED', 'COMPLETE', 'ARCHIVED'],
  COMPLETE: ['ARCHIVED'],
  ARCHIVED: ['NEW'],
};

export function createTask(db: DB, input: CreateTaskInput): Task {
  const result = db
    .prepare(
      `INSERT INTO tasks
        (project_id, title, notes, priority, duration_minutes, due, snooze_until, depends_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.project_id,
      input.title,
      input.notes ?? null,
      input.priority ?? 'LOW',
      input.duration_minutes ?? 30,
      input.due ?? null,
      input.snooze_until ?? null,
      input.depends_on ?? null,
    );
  return getTask(db, Number(result.lastInsertRowid)) as Task;
}

export function getTask(db: DB, id: number): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | Task
    | undefined;
  return row ?? null;
}

export function updateTask(db: DB, id: number, patch: UpdateTaskInput): Task {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
  return getTask(db, id) as Task;
}

export function setTaskStatus(
  db: DB,
  id: number,
  next: TaskStatus,
): Task {
  const current = getTask(db, id);
  if (!current) throw new Error(`task ${id} not found`);
  const allowed = ALLOWED_TRANSITIONS[current.status];
  if (!allowed.includes(next)) {
    throw new Error(
      `illegal status transition ${current.status} -> ${next} for task ${id}`,
    );
  }
  db.prepare(
    "UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(next, id);
  return getTask(db, id) as Task;
}

export interface ListTasksOpts {
  project_id?: string;
  status?: TaskStatus;
  due_before?: string;
}

export function listTasks(db: DB, opts: ListTasksOpts = {}): Task[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (opts.project_id) {
    where.push('project_id = ?');
    values.push(opts.project_id);
  }
  if (opts.status) {
    where.push('status = ?');
    values.push(opts.status);
  }
  if (opts.due_before) {
    where.push('due IS NOT NULL AND due < ?');
    values.push(opts.due_before);
  }
  const sql =
    'SELECT * FROM tasks' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY id';
  return db.prepare(sql).all(...values) as Task[];
}

export function searchTasks(db: DB, query: string): Task[] {
  const like = `%${query.toLowerCase()}%`;
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE LOWER(title) LIKE ? OR LOWER(IFNULL(notes, '')) LIKE ?
       ORDER BY id`,
    )
    .all(like, like) as Task[];
}

export function deleteTask(db: DB, id: number): void {
  setTaskStatus(db, id, 'ARCHIVED');
}
