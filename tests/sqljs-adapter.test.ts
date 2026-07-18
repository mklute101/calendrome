/**
 * Cross-engine guarantee for the in-browser playground: the same core
 * functions the MCP server and GUI server run against better-sqlite3
 * must behave identically against the sql.js (WASM) adapter. Exercises
 * the full playground boot path (schema → seed → week payload) plus
 * the GUI mutations and a domain-guard rejection.
 */
import { describe, expect, it } from 'vitest';
import { freshSqlJsDb } from './helpers/sqljs.js';
import { seedDemo } from '../src/demo-seed.js';
import { buildWeekPayload } from '../src/gui/week-data.js';
import { buildTasksPayload } from '../src/gui/tasks-data.js';
import {
  guiPlace,
  guiMove,
  guiComplete,
  guiSnooze,
  guiSkip,
  reopenTask,
} from '../src/gui/mutations.js';
import { listProjects } from '../src/projects.js';
import type { CalendarClient } from '../src/calendar/types.js';
import type { Task } from '../src/tasks.js';

const fakeCalendar: CalendarClient = {
  async createEvent() {
    return { id: `evt-${Math.random().toString(36).slice(2)}` };
  },
  async deleteEvent() {},
};

/** Monday of the current week, local time, as YYYY-MM-DD. */
function currentMonday(): string {
  const now = new Date();
  const day = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() + (day === 0 ? -6 : 1 - day));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${mon.getFullYear()}-${pad(mon.getMonth() + 1)}-${pad(mon.getDate())}`;
}

describe('sql.js adapter — primitives', () => {
  it('run() reports changes and lastInsertRowid', async () => {
    const db = await freshSqlJsDb();
    const r1 = db
      .prepare(`INSERT INTO projects (id, name, prefix) VALUES (?, ?, ?)`)
      .run('p1', 'P One', 'P1');
    expect(r1.changes).toBe(1);
    const r2 = db
      .prepare(`INSERT INTO tasks (project_id, title) VALUES (?, ?)`)
      .run('p1', 'first');
    expect(Number(r2.lastInsertRowid)).toBeGreaterThan(0);
    const updated = db
      .prepare(`UPDATE tasks SET title = ? WHERE project_id = ?`)
      .run('renamed', 'p1');
    expect(updated.changes).toBe(1);
  });

  it('get() returns undefined on no row; all() returns row objects', async () => {
    const db = await freshSqlJsDb();
    expect(db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(999)).toBeUndefined();
    const cats = db.prepare(`SELECT id FROM categories ORDER BY display_order`).all() as {
      id: string;
    }[];
    expect(cats.map((c) => c.id)).toEqual(['work', 'personal']);
  });

  it('transaction() rolls back on throw', async () => {
    const db = await freshSqlJsDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('p1', 'P', 'P1')`).run();
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO tasks (project_id, title) VALUES ('p1', 'doomed')`).run();
      throw new Error('boom');
    });
    expect(() => tx()).toThrow('boom');
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('enforces foreign keys like openDatabase() does', async () => {
    const db = await freshSqlJsDb();
    expect(() =>
      db.prepare(`INSERT INTO tasks (project_id, title) VALUES ('nope', 'x')`).run(),
    ).toThrow();
  });
});

describe('sql.js adapter — playground boot path', () => {
  it('seeds the demo dataset and builds the week payload', async () => {
    const db = await freshSqlJsDb();
    const summary = seedDemo(db);
    expect(summary).toEqual({ projects: 3, tasks: 8, placements: 5, habits: 1 });

    const projects = listProjects(db, { active: true });
    expect(projects.map((p) => p.id).sort()).toEqual(['acme', 'globex', 'hobby']);

    const week = buildWeekPayload(db, currentMonday());
    expect(week.placements).toHaveLength(5);
    expect(week.time_logs).toHaveLength(1);
    expect(week.habit_instances.length).toBe(5); // Mon–Fri standup
    expect(week.budgets.find((b: any) => b.project_id === 'globex')).toBeTruthy();

    const tasks = buildTasksPayload(db);
    // 8 seeded minus 1 COMPLETE = 7 pending.
    expect(tasks.tasks).toHaveLength(7);
  });

  it('is idempotent — reseeding leaves the same final state', async () => {
    const db = await freshSqlJsDb();
    seedDemo(db);
    seedDemo(db);
    const week = buildWeekPayload(db, currentMonday());
    expect(week.placements).toHaveLength(5);
    expect(week.time_logs).toHaveLength(1);
  });
});

describe('sql.js adapter — GUI mutations', () => {
  async function seeded() {
    const db = await freshSqlJsDb();
    seedDemo(db);
    return db;
  }

  function newTask(db: Awaited<ReturnType<typeof seeded>>): Task {
    const week = buildTasksPayload(db);
    const t = week.tasks.find((t) => t.status === 'NEW');
    expect(t).toBeTruthy();
    return t!;
  }

  it('places a NEW task (drag from panel)', async () => {
    const db = await seeded();
    const task = newTask(db);
    const result = await guiPlace(db, fakeCalendar, {
      task_id: task.id,
      start: '2026-07-15T15:00:00Z',
    });
    expect(result.task.status).toBe('SCHEDULED');
    expect(result.time_entry_id).toBeGreaterThan(0);
    const row = db
      .prepare(`SELECT * FROM time_entry WHERE id = ?`)
      .get(result.time_entry_id) as any;
    expect(row.source).toBe('placement');
    expect(row.status).toBe('UNCONFIRMED');
  });

  it('moves and resizes a placement (drag on timeline)', async () => {
    const db = await seeded();
    const entry = db
      .prepare(`SELECT id FROM time_entry WHERE external_id = 'demo:mon-acme-1'`)
      .get() as { id: number };
    const moved = guiMove(db, entry.id, { start: '2026-07-16T11:00:00Z' });
    expect(moved.placement.start_at).toBe('2026-07-16T11:00:00Z');
    // duration preserved: 120min
    expect(moved.placement.end_at).toBe('2026-07-16T13:00:00Z');
  });

  it('skips a placement and returns the deleted span for undo', async () => {
    const db = await seeded();
    const entry = db
      .prepare(`SELECT id, task_id FROM time_entry WHERE external_id = 'demo:tue-acme-1'`)
      .get() as { id: number; task_id: number };
    const { deleted } = guiSkip(db, entry.id);
    expect(deleted.task_id).toBe(entry.task_id);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM time_entry WHERE id = ?`).get(entry.id),
    ).toEqual({ n: 0 });
  });

  it('completes, then reopens (undo), then snoozes a task', async () => {
    const db = await seeded();
    const task = newTask(db);
    const done = guiComplete(db, task.id);
    expect(done.task.status).toBe('COMPLETE');
    const reopened = reopenTask(db, task.id, 'NEW');
    expect(reopened.task.status).toBe('NEW');
    const snoozed = guiSnooze(db, task.id, '2026-08-01');
    expect(snoozed.task.snooze_until).toBe('2026-08-01');
  });

  it('rejects moving a CONFIRMED entry (domain guard)', async () => {
    const db = await seeded();
    const confirmed = db
      .prepare(`SELECT id FROM time_entry WHERE status = 'CONFIRMED' LIMIT 1`)
      .get() as { id: number };
    expect(() =>
      guiMove(db, confirmed.id, { start: '2026-07-16T09:00:00Z' }),
    ).toThrow(/cannot move a confirmed entry/);
  });
});
