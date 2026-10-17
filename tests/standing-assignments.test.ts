import { describe, it, expect } from 'vitest';
import { openDatabase, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { freshDb } from './helpers/db.js';
import { buildTools } from '../src/mcp/tools/index.js';
import { getProjectBudget, getAllBudgets } from '../src/budgets.js';
import {
  assignHours,
  getEnvelopes,
  pullHours,
  standingDefault,
} from '../src/assignments.js';
import { computeWeekSupply } from '../src/supply.js';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
} from '../src/projects.js';
import {
  STANDING_WEEK,
  effectiveAssignment,
  getStandingProjectMinutes,
} from '../src/standing-assignments.js';
import { foldWeeklyBudgetColumn } from '../src/db/migrate.js';
import { insertTimeEntry } from '../src/time-entry.js';

// The pre-#173 projects DDL, verbatim from origin/main before the cutover.
const LEGACY_PROJECTS_DDL = `
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL UNIQUE,
  calendar_id TEXT,
  color       TEXT,
  weekly_budget_minutes INTEGER,
  harvest_project_id INTEGER,
  harvest_task_id INTEGER,
  category_id TEXT REFERENCES categories(id),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const PAST = '2026-06-01';
const OVERRIDE_WEEK = '2026-07-13';
const CURRENT = '2026-07-20';
const FUTURE = '2027-03-01'; // far future: no explicit row will ever exist
const WEEKS = [PAST, OVERRIDE_WEEK, CURRENT, FUTURE];

/** An existing pre-#173 DB: legacy projects table, caps in the column. */
function legacyDb(): DB {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE categories (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      display_order  INTEGER NOT NULL DEFAULT 0,
      default_window TEXT,
      timezone       TEXT NOT NULL DEFAULT 'UTC',
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO categories (id, name, display_order, default_window, timezone)
    VALUES ('work', 'Work', 0, '{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}', 'America/Chicago');
  `);
  db.exec(LEGACY_PROJECTS_DDL);
  const ins = db.prepare(
    `INSERT INTO projects (id, name, prefix, weekly_budget_minutes, category_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  ins.run('acme', 'Acme', 'ACME', 600, 'work'); // capped 10h
  ins.run('zero', 'Zero', 'ZERO', 0, 'work'); // a real 0h cap
  ins.run('open', 'Open', 'OPEN', null, 'work'); // uncapped (#150)
  return db;
}

/** The legacy columns' values, read before migrate() runs. */
function legacyCaps(db: DB): Record<string, number | null> {
  const rows = db
    .prepare('SELECT id, weekly_budget_minutes AS m FROM projects')
    .all() as { id: string; m: number | null }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.m]));
}

async function tool(db: DB, name: string, args: Record<string, unknown>) {
  const t = buildTools(db).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (await t.handler(args)) as any;
}

describe('M5 migration: weekly_budget_minutes -> standing assignments (#173)', () => {
  it('turns each non-null cap into a standing project row and drops the column', () => {
    const db = legacyDb();
    migrate(db);

    const cols = (db.prepare("PRAGMA table_info('projects')").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('weekly_budget_minutes');

    const rows = db
      .prepare(
        `SELECT envelope_type, envelope_id, week_start, minutes FROM assignments
          ORDER BY envelope_id`,
      )
      .all();
    expect(rows).toEqual([
      { envelope_type: 'project', envelope_id: 'acme', week_start: STANDING_WEEK, minutes: 600 },
      { envelope_type: 'project', envelope_id: 'zero', week_start: STANDING_WEEK, minutes: 0 },
    ]);
  });

  it('is idempotent: a second migrate() changes nothing', () => {
    const db = legacyDb();
    migrate(db);
    const before = db.prepare('SELECT * FROM assignments ORDER BY envelope_id').all();
    migrate(db);
    foldWeeklyBudgetColumn(db);
    expect(db.prepare('SELECT * FROM assignments ORDER BY envelope_id').all()).toEqual(before);
  });

  it('every budget reader reports the same effective cap in every week, before and after', async () => {
    const db = legacyDb();
    const before = legacyCaps(db);
    migrate(db);

    for (const week of WEEKS) {
      for (const id of ['acme', 'zero', 'open']) {
        const cap = before[id];
        // Readers 1-2: getProjectBudget / get_project_budget
        expect(getProjectBudget(db, id, week).assigned_minutes).toBe(cap);
        const viaTool = await tool(db, 'get_project_budget', { project_id: id, week_start: week });
        expect(viaTool.budget.assigned_minutes).toBe(cap);
        // Reader 3: the envelope standing default (pull seeding, get_envelopes fallback)
        expect(standingDefault(db, 'project', id, week)).toBe(cap);
        // Reader 4: project list/get (the API field)
        expect(getProject(db, id)!.weekly_budget_minutes).toBe(cap);
      }
      // Readers 5-6: getAllBudgets / get_all_budgets
      const all = Object.fromEntries(
        getAllBudgets(db, week).map((b) => [b.project_id, b.assigned_minutes]),
      );
      expect(all).toEqual(before);
      const allTool = await tool(db, 'get_all_budgets', { week_start: week });
      expect(
        Object.fromEntries(allTool.budgets.map((b: any) => [b.project_id, b.assigned_minutes])),
      ).toEqual(before);
      // Readers 7-8: getEnvelopes / get_envelopes
      const env = Object.fromEntries(
        getEnvelopes(db, week)
          .filter((e) => e.envelope_type === 'project')
          .map((e) => [e.envelope_id, e.assigned]),
      );
      expect(env).toEqual(before);
      const envTool = await tool(db, 'get_envelopes', { week_start: week });
      expect(
        Object.fromEntries(
          envTool.envelopes
            .filter((e: any) => e.envelope_type === 'project')
            .map((e: any) => [e.envelope_id, e.assigned]),
        ),
      ).toEqual(before);
      // Readers 9-10: computeWeekSupply / get_supply assigned total (600 + 0; uncapped = 0)
      expect(computeWeekSupply(db, week).assigned_minutes).toBe(600);
      const supplyTool = await tool(db, 'get_supply', { week_start: week });
      expect(supplyTool.supply.assigned_minutes).toBe(600);
    }
  });

  it('an explicit week row still overrides only its week; budgets now agree with envelopes', () => {
    const db = legacyDb();
    migrate(db);
    assignHours(db, {
      envelope_type: 'project',
      envelope_id: 'acme',
      week_start: OVERRIDE_WEEK,
      minutes: 900,
    });
    expect(getProjectBudget(db, 'acme', OVERRIDE_WEEK).assigned_minutes).toBe(900);
    const env = getEnvelopes(db, OVERRIDE_WEEK).find((e) => e.envelope_id === 'acme')!;
    expect(env.assigned).toBe(900);
    for (const week of [PAST, CURRENT, FUTURE]) {
      expect(getProjectBudget(db, 'acme', week).assigned_minutes).toBe(600);
      expect(effectiveAssignment(db, 'project', 'acme', week)).toEqual({
        minutes: 600,
        source: 'standing',
        snoozed: false,
      });
    }
  });

  it('a snoozed week reads as null assigned + snoozed, not overspent, in get_project_budget', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme', prefix: 'ACME', weekly_budget_minutes: 600 });
    assignHours(db, { envelope_type: 'project', envelope_id: 'acme', week_start: CURRENT, minutes: null });
    insertTimeEntry(db, {
      project_id: 'acme',
      start_at: '2026-07-21T15:00:00Z',
      end_at: '2026-07-21T16:00:00Z',
      status: 'CONFIRMED',
      source: 'manual',
    });
    const b = getProjectBudget(db, 'acme', CURRENT);
    expect(b).toMatchObject({
      assigned_minutes: null,
      confirmed_minutes: 60,
      available_minutes: -60,
      overspent: false,
      snoozed: true,
    });
    expect(getProjectBudget(db, 'acme', FUTURE)).toMatchObject({
      assigned_minutes: 600,
      snoozed: false,
    });
  });

  it('pull_hours seeds from the standing row, never writes it', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme', prefix: 'ACME', weekly_budget_minutes: 600 });
    createProject(db, { id: 'hobby', name: 'Hobby', prefix: 'HOBBY', weekly_budget_minutes: 120 });
    pullHours(db, {
      week_start: CURRENT,
      from: { type: 'project', id: 'acme' },
      to: { type: 'project', id: 'hobby' },
      minutes: 60,
    });
    expect(getProjectBudget(db, 'acme', CURRENT).assigned_minutes).toBe(540);
    expect(getProjectBudget(db, 'hobby', CURRENT).assigned_minutes).toBe(180);
    expect(getStandingProjectMinutes(db, 'acme')).toBe(600);
    expect(getProjectBudget(db, 'acme', FUTURE).assigned_minutes).toBe(600);
  });
});

describe('standing assignment writes through the project API (#173)', () => {
  it('create/update/list_projects keep the weekly_budget_minutes field, backed by the standing row', async () => {
    const db = freshDb();
    const { project } = await tool(db, 'create_project', {
      id: 'acme',
      name: 'Acme',
      prefix: 'ACME',
      weekly_budget_minutes: 1200,
    });
    expect(project.weekly_budget_minutes).toBe(1200);
    expect(getStandingProjectMinutes(db, 'acme')).toBe(1200);

    const upd = await tool(db, 'update_project', { id: 'acme', weekly_budget_minutes: 300 });
    expect(upd.project.weekly_budget_minutes).toBe(300);
    expect(getProjectBudget(db, 'acme', FUTURE).assigned_minutes).toBe(300);

    // Patching another field leaves the cap alone.
    await tool(db, 'update_project', { id: 'acme', name: 'Acme Corp' });
    expect(getStandingProjectMinutes(db, 'acme')).toBe(300);

    const { projects } = await tool(db, 'list_projects', { category_id: 'work' });
    expect(projects).toEqual([expect.objectContaining({ id: 'acme', weekly_budget_minutes: 300 })]);

    // NULL clears the standing row: uncapped, not a 0h cap.
    await tool(db, 'update_project', { id: 'acme', weekly_budget_minutes: null });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM assignments').get() as { n: number };
    expect(rows.n).toBe(0);
    expect(getProjectBudget(db, 'acme', FUTURE).assigned_minutes).toBeNull();
    expect(listProjects(db)[0].weekly_budget_minutes).toBeNull();
  });

  it('rejects a non-integer or negative cap, and never orphans a row for an unknown project', () => {
    const db = freshDb();
    expect(() =>
      createProject(db, { id: 'x', name: 'X', prefix: 'X', weekly_budget_minutes: -5 }),
    ).toThrow(/non-negative integer/);
    // The failed create rolled back with its project row.
    expect(getProject(db, 'x')).toBeNull();
    updateProject(db, 'ghost', { weekly_budget_minutes: 60 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM assignments').get()).toEqual({ n: 0 });
  });

  it("assign_hours cannot write the standing row (week_start 'standing' is not a Monday)", () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme', prefix: 'ACME', weekly_budget_minutes: 600 });
    expect(() =>
      assignHours(db, {
        envelope_type: 'project',
        envelope_id: 'acme',
        week_start: STANDING_WEEK,
        minutes: 0,
      }),
    ).toThrow();
    expect(getStandingProjectMinutes(db, 'acme')).toBe(600);
  });
});
