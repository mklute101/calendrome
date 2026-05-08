import type { DB } from './db/connection.js';

export interface Project {
  id: string;
  name: string;
  prefix: string;
  calendar_id: string | null;
  color: string | null;
  weekly_budget_minutes: number | null;
  harvest_project_id: number | null;
  harvest_task_id: number | null;
  category_id: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  id: string;
  name: string;
  prefix: string;
  calendar_id?: string | null;
  color?: string | null;
  weekly_budget_minutes?: number | null;
  harvest_project_id?: number | null;
  harvest_task_id?: number | null;
  category_id?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  prefix?: string;
  calendar_id?: string | null;
  color?: string | null;
  weekly_budget_minutes?: number | null;
  harvest_project_id?: number | null;
  harvest_task_id?: number | null;
  category_id?: string | null;
  active?: number;
}

export function createProject(db: DB, input: CreateProjectInput): Project {
  db.prepare(
    `INSERT INTO projects (id, name, prefix, calendar_id, color, weekly_budget_minutes, harvest_project_id, harvest_task_id, category_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.prefix,
    input.calendar_id ?? null,
    input.color ?? null,
    input.weekly_budget_minutes ?? null,
    input.harvest_project_id ?? null,
    input.harvest_task_id ?? null,
    input.category_id ?? 'work',
  );
  return getProject(db, input.id) as Project;
}

export function getProject(db: DB, id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | Project
    | undefined;
  return row ?? null;
}

export function updateProject(
  db: DB,
  id: string,
  patch: UpdateProjectInput,
): Project {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
  return getProject(db, id) as Project;
}

export interface ListProjectsOpts {
  active?: boolean;
  category_id?: string | string[];
}

export function listProjects(db: DB, opts: ListProjectsOpts = {}): Project[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (opts.active !== undefined) {
    where.push('active = ?');
    values.push(opts.active ? 1 : 0);
  }
  if (opts.category_id !== undefined) {
    const cats = Array.isArray(opts.category_id)
      ? opts.category_id
      : [opts.category_id];
    if (cats.length > 0) {
      const placeholders = cats.map(() => '?').join(', ');
      where.push(`category_id IN (${placeholders})`);
      values.push(...cats);
    }
  }
  const sql =
    'SELECT * FROM projects' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY id';
  return db.prepare(sql).all(...values) as Project[];
}
