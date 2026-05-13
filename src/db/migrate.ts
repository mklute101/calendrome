import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_WORK_WINDOW = JSON.stringify({
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '17:00',
});
const DEFAULT_PERSONAL_WINDOW = JSON.stringify({
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '18:00',
  end: '22:00',
});

function hasColumn(db: DB, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as {
    name: string;
  }[];
  return cols.some((c) => c.name === column);
}

export function migrate(db: DB): void {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);

  if (!hasColumn(db, 'projects', 'category_id')) {
    db.exec(
      'ALTER TABLE projects ADD COLUMN category_id TEXT REFERENCES categories(id)',
    );
  }

  if (!hasColumn(db, 'habit_instances', 'time_entry_id')) {
    db.exec(
      'ALTER TABLE habit_instances ADD COLUMN time_entry_id INTEGER REFERENCES time_entry(id)',
    );
  }

  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }
  ).n;
  if (count === 0) {
    const insert = db.prepare(
      `INSERT INTO categories (id, name, display_order, default_window, timezone)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('work', 'Work', 0, DEFAULT_WORK_WINDOW, 'UTC');
    insert.run('personal', 'Personal', 1, DEFAULT_PERSONAL_WINDOW, 'UTC');
  }

  // Backfill: projects with no category land in 'work' (where everything
  // has lived up to now). Keeps existing installs functional.
  db.prepare(
    "UPDATE projects SET category_id = 'work' WHERE category_id IS NULL",
  ).run();
}
