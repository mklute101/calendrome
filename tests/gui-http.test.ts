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
