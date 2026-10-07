/**
 * Categories — top-level scheduling windows that every project belongs to.
 *
 * The work/personal split serves two jobs at once: it filters the GUI
 * for screen-share safety (you don't want personal projects on the
 * shared screen during a client call), and it tells the planner *when*
 * a project's work is allowed to be scheduled. A `work` task lands
 * Mon-Fri 9-5; a `personal` task lands evenings/weekends. Same data,
 * two uses — that's why categories aren't just a tag.
 *
 * Each category owns a `default_window` (a JSON `{ days, start, end }`
 * object) and a timezone. The migration seeds `work` and `personal`
 * on a fresh DB; new categories can be created via MCP.
 */
import type { DB } from './db/connection.js';
import { now, nowDate } from './clock.js';
import { assertValidTimezone, currentWeekMonday } from './day-range.js';

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
  if (input.timezone !== undefined) assertValidTimezone(input.timezone);
  db.prepare(
    `INSERT INTO categories (id, name, display_order, default_window, timezone, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.display_order ?? 0,
    input.default_window ? JSON.stringify(input.default_window) : null,
    input.timezone ?? 'UTC',
    now(),
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
    assertValidTimezone(patch.timezone);
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

/**
 * IANA timezone that weekly accounting for `projectId` follows (#146):
 * the project's category timezone. A project with no category — or an
 * entry with no project at all — falls back to the 'work' category,
 * the same `COALESCE(category_id, 'work')` rule the supply computation
 * and the GUI apply, so every surface buckets such rows identically.
 * An unknown category resolves to 'UTC' (the former arithmetic).
 */
export function projectTimezone(db: DB, projectId: string | null): string {
  const row = db
    .prepare(
      `SELECT timezone FROM categories
        WHERE id = COALESCE((SELECT category_id FROM projects WHERE id = ?), 'work')`,
    )
    .get(projectId) as { timezone: string } | undefined;
  return row?.timezone ?? 'UTC';
}

/**
 * Default `week_start` for tools called without one (#146): the local
 * Monday of the week `now` falls in, per category. Categories only
 * disagree within a few hours of a Monday boundary; the earliest wins
 * so a Sunday-evening caller west of UTC still sees the week they are
 * finishing. 'UTC' when no categories exist.
 */
export function currentLocalWeekMonday(db: DB, now: Date = nowDate()): string {
  const mondays = listCategories(db).map((c) => currentWeekMonday(now, c.timezone));
  if (mondays.length === 0) return currentWeekMonday(now, 'UTC');
  return mondays.sort()[0];
}
