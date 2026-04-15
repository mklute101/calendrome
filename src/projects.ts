import type { DB } from './db/connection.js';

export interface Project {
  id: string;
  name: string;
  prefix: string;
  calendar_id: string | null;
  color: string | null;
  weekly_budget_minutes: number | null;
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
}

export interface UpdateProjectInput {
  name?: string;
  prefix?: string;
  calendar_id?: string | null;
  color?: string | null;
  weekly_budget_minutes?: number | null;
  active?: number;
}

export function createProject(db: DB, input: CreateProjectInput): Project {
  db.prepare(
    `INSERT INTO projects (id, name, prefix, calendar_id, color, weekly_budget_minutes)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.prefix,
    input.calendar_id ?? null,
    input.color ?? null,
    input.weekly_budget_minutes ?? null,
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

export function listProjects(
  db: DB,
  opts: { active?: boolean } = {},
): Project[] {
  if (opts.active === undefined) {
    return db
      .prepare('SELECT * FROM projects ORDER BY id')
      .all() as Project[];
  }
  return db
    .prepare('SELECT * FROM projects WHERE active = ? ORDER BY id')
    .all(opts.active ? 1 : 0) as Project[];
}
