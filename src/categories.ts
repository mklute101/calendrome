import type { DB } from './db/connection.js';

export interface CategoryWindow {
  // 0=Sun..6=Sat
  days: number[];
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
}

export interface Category {
  id: string;
  name: string;
  display_order: number;
  default_window: CategoryWindow | null;
  timezone: string;
  created_at: string;
}

interface CategoryRow {
  id: string;
  name: string;
  display_order: number;
  default_window: string | null;
  timezone: string;
  created_at: string;
}

function rowToCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    display_order: row.display_order,
    default_window: row.default_window
      ? (JSON.parse(row.default_window) as CategoryWindow)
      : null,
    timezone: row.timezone,
    created_at: row.created_at,
  };
}

export interface CreateCategoryInput {
  id: string;
  name: string;
  display_order?: number;
  default_window?: CategoryWindow | null;
  timezone?: string;
}

export interface UpdateCategoryInput {
  name?: string;
  display_order?: number;
  default_window?: CategoryWindow | null;
  timezone?: string;
}

export function createCategory(db: DB, input: CreateCategoryInput): Category {
  db.prepare(
    `INSERT INTO categories (id, name, display_order, default_window, timezone)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.display_order ?? 0,
    input.default_window ? JSON.stringify(input.default_window) : null,
    input.timezone ?? 'UTC',
  );
  return getCategory(db, input.id) as Category;
}

export function getCategory(db: DB, id: string): Category | null {
  const row = db
    .prepare('SELECT * FROM categories WHERE id = ?')
    .get(id) as CategoryRow | undefined;
  return row ? rowToCategory(row) : null;
}

export function listCategories(db: DB): Category[] {
  const rows = db
    .prepare('SELECT * FROM categories ORDER BY display_order, id')
    .all() as CategoryRow[];
  return rows.map(rowToCategory);
}

export function updateCategory(
  db: DB,
  id: string,
  patch: UpdateCategoryInput,
): Category {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    values.push(patch.name);
  }
  if (patch.display_order !== undefined) {
    fields.push('display_order = ?');
    values.push(patch.display_order);
  }
  if (patch.default_window !== undefined) {
    fields.push('default_window = ?');
    values.push(patch.default_window ? JSON.stringify(patch.default_window) : null);
  }
  if (patch.timezone !== undefined) {
    fields.push('timezone = ?');
    values.push(patch.timezone);
  }
  if (fields.length === 0) {
    return getCategory(db, id) as Category;
  }
  values.push(id);
  db.prepare(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
  const updated = getCategory(db, id);
  if (!updated) throw new Error(`category ${id} not found`);
  return updated;
}
