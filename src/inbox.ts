import type { DB } from './db/connection.js';
import { createTask, type Task } from './tasks.js';

export interface InboxItem {
  id: number;
  title: string;
  notes: string | null;
  processed: number;
  created_at: string;
}

export interface InboxAddInput {
  title: string;
  notes?: string | null;
}

export function inboxAdd(db: DB, input: InboxAddInput): InboxItem {
  const result = db
    .prepare('INSERT INTO inbox (title, notes) VALUES (?, ?)')
    .run(input.title, input.notes ?? null);
  return db
    .prepare('SELECT * FROM inbox WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as InboxItem;
}

export function inboxList(db: DB): InboxItem[] {
  return db
    .prepare('SELECT * FROM inbox WHERE processed = 0 ORDER BY created_at, id')
    .all() as InboxItem[];
}

export function inboxNext(db: DB): InboxItem | null {
  const row = db
    .prepare(
      'SELECT * FROM inbox WHERE processed = 0 ORDER BY created_at, id LIMIT 1',
    )
    .get() as InboxItem | undefined;
  return row ?? null;
}

export function inboxProcess(
  db: DB,
  id: number,
  projectId: string,
): Task {
  const item = db
    .prepare('SELECT * FROM inbox WHERE id = ?')
    .get(id) as InboxItem | undefined;
  if (!item) throw new Error(`inbox item ${id} not found`);
  if (item.processed) {
    throw new Error(`inbox item ${id} already processed`);
  }

  const tx = db.transaction(() => {
    const task = createTask(db, {
      project_id: projectId,
      title: item.title,
      notes: item.notes,
    });
    db.prepare('UPDATE inbox SET processed = 1 WHERE id = ?').run(id);
    return task;
  });
  return tx();
}
