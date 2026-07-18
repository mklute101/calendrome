import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createTask } from '../src/tasks.js';
import { FakeCalendarClient } from '../src/calendar/index.js';
import { createApp } from '../src/gui/server.js';

/**
 * HTTP smoke tests for the GUI write API (#24, #86): error shapes,
 * the Origin guard, and one happy place→move→confirm chain. Deep
 * mutation coverage lives in gui-mutations.test.ts — this file only
 * proves the HTTP layer wires bodies, params, and errors correctly.
 * File-backed DB because createApp opens a connection per request.
 */
describe('GUI write API over HTTP', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let taskId: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'calendrome-http-'));
    const dbPath = join(dir, 'calendrome.db');
    const db = openDatabase(dbPath);
    migrate(db);
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('acme', 'Acme', 'ACME')`).run();
    taskId = createTask(db, {
      project_id: 'acme',
      title: 'HTTP test task',
      duration_minutes: 60,
    }).id;
    db.close();

    const app = createApp(dbPath, new FakeCalendarClient());
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  // node fetch types return `unknown` from json(); the assertions are the contract here.
  const json = (r: Response): Promise<any> => r.json() as Promise<any>;

  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('rejects malformed bodies with 400', async () => {
    const res = await post('/api/placements', { start: '2026-07-13T09:00:00Z' });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/task_id/);

    const res2 = await post(`/api/tasks/${taskId}/snooze`, {});
    expect(res2.status).toBe(400);
  });

  it('rejects cross-origin writes with 403 but allows localhost origins', async () => {
    const evil = await post(`/api/tasks/${taskId}/complete`, undefined, {
      origin: 'https://evil.example.com',
    });
    expect(evil.status).toBe(403);
    expect((await json(evil)).error).toMatch(/cross-origin/);

    const local = await post(`/api/tasks/${taskId}/snooze`, { until: null }, {
      origin: 'http://localhost:5173',
    });
    expect(local.status).toBe(200);
  });

  it('maps not-found to 404 and guard violations to 409', async () => {
    const missing = await post('/api/placements/9999/move', {
      start: '2026-07-13T09:00:00Z',
    });
    expect(missing.status).toBe(404);

    // Complete the task, then try completing again — illegal transition → 409.
    expect((await post(`/api/tasks/${taskId}/complete`)).status).toBe(200);
    const again = await post(`/api/tasks/${taskId}/complete`);
    expect(again.status).toBe(409);
    expect((await json(again)).error).toMatch(/illegal status transition/);
    // Reopen for the happy-path test below.
    expect(
      (await post(`/api/tasks/${taskId}/reopen`, { status: 'NEW' })).status,
    ).toBe(200);
  });

  it('happy chain: place → move → confirm', async () => {
    const placed = await post('/api/placements', {
      task_id: taskId,
      start: '2026-07-13T09:00:00Z',
    });
    expect(placed.status).toBe(200);
    const { time_entry_id, task } = await json(placed);
    expect(task.status).toBe('SCHEDULED');

    const moved = await post(`/api/placements/${time_entry_id}/move`, {
      start: '2026-07-14T13:00:00Z',
    });
    expect(moved.status).toBe(200);
    const { placement } = await json(moved);
    expect(placement.start_at).toBe('2026-07-14T13:00:00Z');
    expect(placement.end_at).toBe('2026-07-14T14:00:00Z');

    const confirmed = await post(`/api/placements/${time_entry_id}/confirm`, {
      actual_minutes: 45,
    });
    expect(confirmed.status).toBe(200);
    expect((await json(confirmed)).time_entry.status).toBe('CONFIRMED');
  });

  it('GET endpoints still serve (regression)', async () => {
    const week = await fetch(`${base}/api/week?start=2026-07-13`);
    expect(week.status).toBe(200);
    const payload = await json(week);
    // The happy chain above confirmed its placement, which moves it
    // from placements[] to time_logs[] — assert it landed there.
    expect(payload.time_logs.length).toBeGreaterThan(0);
  });
});

/**
 * Budget-view API over HTTP (#106 M2): envelopes/moves reads, the
 * assign/pull writes, their validation 400s, and the Origin guard on
 * /api/assign. Core mechanics are covered in assignments.test.ts and
 * gui-mutations.test.ts — this proves the HTTP wiring.
 */
describe('GUI budget API over HTTP', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let goalId: number;
  const WEEK = '2026-07-13'; // Monday

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'calendrome-http-budget-'));
    const dbPath = join(dir, 'calendrome.db');
    const db = openDatabase(dbPath);
    migrate(db);
    db.prepare(
      `INSERT INTO projects (id, name, prefix, weekly_budget_minutes)
       VALUES ('acme', 'Acme', 'ACME', 1200), ('hobby', 'Hobby', 'HOBBY', 300)`,
    ).run();
    goalId = Number(
      db
        .prepare(
          `INSERT INTO goals (project_id, title, target_minutes, refill_period)
           VALUES ('acme', 'Spanish practice', 180, 'week')`,
        )
        .run().lastInsertRowid,
    );
    db.close();

    const app = createApp(dbPath, new FakeCalendarClient());
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const json = (r: Response): Promise<any> => r.json() as Promise<any>;
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('GET /api/envelopes returns rows for the seeded goal, with project_id', async () => {
    const res = await fetch(`${base}/api/envelopes?week=${WEEK}`);
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect(payload.week).toBe(WEEK);
    const goalRow = payload.envelopes.find(
      (e: any) => e.envelope_type === 'goal' && e.envelope_id === String(goalId),
    );
    expect(goalRow).toBeDefined();
    expect(goalRow.title).toBe('Spanish practice');
    expect(goalRow.project_id).toBe('acme');
    expect(goalRow.assigned).toBe(180); // standing weekly ask
    expect(goalRow.funding).toBe('underfunded');
  });

  it('GET /api/envelopes validates the week param', async () => {
    expect((await fetch(`${base}/api/envelopes`)).status).toBe(400);
    // Well-formed but not a Monday → core assertMonday → 400.
    expect((await fetch(`${base}/api/envelopes?week=2026-07-14`)).status).toBe(400);
  });

  it('POST /api/assign sets the assignment; malformed bodies 400', async () => {
    const ok = await post('/api/assign', {
      envelope_type: 'project',
      envelope_id: 'acme',
      week: WEEK,
      minutes: 600,
      note: 'light week',
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).assignment.minutes).toBe(600);

    const bad = await post('/api/assign', {
      envelope_type: 'castle',
      envelope_id: 'acme',
      week: WEEK,
      minutes: 600,
    });
    expect(bad.status).toBe(400);
    const noMinutes = await post('/api/assign', {
      envelope_type: 'project',
      envelope_id: 'acme',
      week: WEEK,
    });
    expect(noMinutes.status).toBe(400);

    // The GUI API says `week` everywhere (#120): the legacy body key
    // is rejected, and the 400 names the right one.
    const legacyKey = await post('/api/assign', {
      envelope_type: 'project',
      envelope_id: 'acme',
      week_start: WEEK,
      minutes: 600,
    });
    expect(legacyKey.status).toBe(400);
    expect((await json(legacyKey)).error).toMatch(/week \(string\)/);
  });

  it('POST /api/assign rejects cross-origin writes (Origin guard)', async () => {
    const evil = await post(
      '/api/assign',
      {
        envelope_type: 'project',
        envelope_id: 'acme',
        week: WEEK,
        minutes: 0,
      },
      { origin: 'https://evil.example.com' },
    );
    expect(evil.status).toBe(403);
    expect((await json(evil)).error).toMatch(/cross-origin/);
  });

  it('POST /api/pull moves minutes and GET /api/moves lists it newest-first', async () => {
    const pulled = await post('/api/pull', {
      week: WEEK,
      from: { type: 'project', id: 'hobby' },
      to: { type: 'goal', id: goalId }, // numeric id must coerce
      minutes: 60,
      note: 'launch crunch',
    });
    expect(pulled.status).toBe(200);
    const { move } = await json(pulled);
    expect(move.from_id).toBe('hobby');
    expect(move.to_id).toBe(String(goalId));

    const moves = await json(await fetch(`${base}/api/moves?week=${WEEK}`));
    expect(moves.moves[0].note).toBe('launch crunch');

    const badRef = await post('/api/pull', {
      week: WEEK,
      from: { kind: 'project', id: 'hobby' },
      minutes: 60,
    });
    expect(badRef.status).toBe(400);

    // Missing `week` (e.g. the pre-#120 `week_start` key) → 400
    // naming the current param.
    const legacyKey = await post('/api/pull', {
      week_start: WEEK,
      from: { type: 'project', id: 'hobby' },
      minutes: 30,
    });
    expect(legacyKey.status).toBe(400);
    expect((await json(legacyKey)).error).toMatch(/week \(string\)/);

    // Domain guard passes through mutate(): overdraw → 409.
    const overdraw = await post('/api/pull', {
      week: WEEK,
      from: { type: 'project', id: 'hobby' },
      to: { type: 'project', id: 'acme' },
      minutes: 100000,
    });
    expect(overdraw.status).toBe(409);
    expect((await json(overdraw)).error).toMatch(/assigned this week/);
  });
  it('GET /api/supply returns totals and validates the week param', async () => {
    const res = await fetch(`${base}/api/supply?week=${WEEK}`);
    expect(res.status).toBe(200);
    const supply = await json(res);
    expect(supply.week_start).toBe(WEEK);
    // Seeded windows: work Mon-Fri 9-17 (2400) + personal daily 18-22 (1680).
    expect(supply.total_supply_minutes).toBe(4080);
    expect(typeof supply.assigned_minutes).toBe('number');
    expect(supply.to_be_assigned_minutes).toBe(
      supply.total_supply_minutes - supply.assigned_minutes,
    );

    const bad = await fetch(`${base}/api/supply?week=2026-07-14`);
    expect(bad.status).toBe(400);
  });
});
