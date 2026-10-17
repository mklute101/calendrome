import type { DB } from './db/connection.js';
import { now } from './clock.js';
import {
  STANDING_WEEK,
  setStandingProjectMinutes,
} from './standing-assignments.js';

/**
 * Projects read their weekly cap from the standing assignment row
 * (#173) — `weekly_budget_minutes` is a derived field, not a column.
 */
const PROJECT_SELECT = `SELECT p.*,
  (SELECT a.minutes FROM assignments a
    WHERE a.envelope_type = 'project' AND a.envelope_id = p.id
      AND a.week_start = '${STANDING_WEEK}') AS weekly_budget_minutes
  FROM projects p`;

export interface Project {
  id: string;
  name: string;
  prefix: string;
  calendar_id: string | null;
  color: string | null;
  /**
   * Standing weekly assignment (the cap side of the project's
   * envelope): the project's `week_start = 'standing'` row in
   * `assignments`, NULL when uncapped (#173). Name kept for the API.
   */
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
  const stamp = now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO projects (id, name, prefix, calendar_id, color, harvest_project_id, harvest_task_id, category_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.prefix,
      input.calendar_id ?? null,
      input.color ?? null,
      input.harvest_project_id ?? null,
      input.harvest_task_id ?? null,
      input.category_id ?? 'work',
      stamp,
      stamp,
    );
    if (input.weekly_budget_minutes != null) {
      setStandingProjectMinutes(db, input.id, input.weekly_budget_minutes);
    }
  })();
  return getProject(db, input.id) as Project;
}

export function getProject(db: DB, id: string): Project | null {
  const row = db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(id) as
    | Project
    | undefined;
  return row ?? null;
}

export function updateProject(
  db: DB,
  id: string,
  patch: UpdateProjectInput,
): Project {
  const { weekly_budget_minutes, ...columns } = patch;
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(columns)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  fields.push('updated_at = ?');
  values.push(now());
  values.push(id);
  db.transaction(() => {
    const { changes } = db
      .prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
    // The cap is the standing assignment row; `undefined` leaves it be,
    // NULL removes it (uncapped). No project, no orphan row.
    if (weekly_budget_minutes !== undefined && changes > 0) {
      setStandingProjectMinutes(db, id, weekly_budget_minutes);
    }
  })();
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
    where.push('p.active = ?');
    values.push(opts.active ? 1 : 0);
  }
  if (opts.category_id !== undefined) {
    const cats = Array.isArray(opts.category_id)
      ? opts.category_id
      : [opts.category_id];
    if (cats.length > 0) {
      const placeholders = cats.map(() => '?').join(', ');
      where.push(`p.category_id IN (${placeholders})`);
      values.push(...cats);
    }
  }
  const sql =
    PROJECT_SELECT +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY p.id';
  return db.prepare(sql).all(...values) as Project[];
}
