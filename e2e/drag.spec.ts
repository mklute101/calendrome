import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end drag test (#24): seed a placement, drag its block two
 * hours down the timeline in a real browser, and assert the DB row
 * moved. Exercises the full chain — pointer events → useTimelineDrag
 * → POST /api/placements/:id/move → moveTimeEntry → SQLite.
 */

const PORT = 3921;
const BASE = `http://127.0.0.1:${PORT}`;

let dir: string;
let server: ChildProcess;
let placementId: number;
let taskId: number;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'calendrome-e2e-'));
  const dbPath = join(dir, 'calendrome.db');

  // Seed via the built modules — same code the server runs.
  const { openDatabase } = await import('../dist/src/db/connection.js');
  const { migrate } = await import('../dist/src/db/migrate.js');
  const { createTask } = await import('../dist/src/tasks.js');
  const { placeTask } = await import('../dist/src/placement.js');
  const { LocalCalendarClient } = await import('../dist/src/calendar/index.js');

  const db = openDatabase(dbPath);
  migrate(db);
  db.prepare(`INSERT INTO projects (id, name, prefix, color) VALUES ('acme', 'Acme', 'ACME', '#58a6ff')`).run();
  taskId = createTask(db, {
    project_id: 'acme',
    title: 'Drag me',
    duration_minutes: 60,
  }).id;
  // Place mid-week at 9am local so the block is visible and there is
  // room to drag downward.
  const monday = getMonday(new Date());
  const wedNineAm = new Date(`${addDays(monday, 2)}T09:00:00`);
  const placed = await placeTask(db, new LocalCalendarClient(), {
    task_id: taskId,
    start: wedNineAm.toISOString(),
  });
  placementId = placed.time_entry_id;
  db.close();

  server = spawn(process.execPath, ['dist/src/gui/server.js'], {
    env: { ...process.env, CALENDROME_DB: dbPath, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForServer();
});

test.afterAll(async () => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('dragging a placement block reschedules it in the DB', async ({ page }) => {
  await page.goto(BASE);
  await page.click('text=Timeline');

  const block = page.locator('.timeline-block.placement', { hasText: 'Drag me' });
  await expect(block).toBeVisible();
  const before = await currentStart();

  // Drag the block 120px down = +2 hours on the 60px/hour grid.
  const box = (await block.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  // Two intermediate moves so the 4px threshold trips and the ghost tracks.
  await page.mouse.move(box.x + box.width / 2, box.y + 68, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2, box.y + 128, { steps: 5 });
  await page.mouse.up();

  // The move lands asynchronously (optimistic UI + POST + refetch).
  await expect
    .poll(currentStart, { timeout: 10_000 })
    .not.toBe(before);
  const after = new Date(await currentStart());
  const expected = new Date(before);
  expected.setHours(expected.getHours() + 2);
  expect(after.getTime()).toBe(expected.getTime());

  // Undo toast appeared for the move.
  await expect(page.locator('.toast', { hasText: 'Moved' })).toBeVisible();
});

test('completing a task from the panel writes through', async ({ page }) => {
  await page.goto(BASE);
  await page.click('text=Tasks');
  // The seeded task is SCHEDULED, so it appears in the panel with actions.
  const row = page.locator('.task-row', { hasText: 'Drag me' });
  await expect(row).toBeVisible();
  await row.locator('button[title="Mark complete"]').click();
  await expect(page.locator('.toast', { hasText: 'Completed' })).toBeVisible();

  const tasks = (await (await fetch(`${BASE}/api/tasks`)).json()) as {
    tasks: { id: number }[];
  };
  expect(tasks.tasks.find((t) => t.id === taskId)).toBeUndefined();

  // Undo brings it back (reopen path).
  await page.locator('.toast .toast-undo').click();
  await expect
    .poll(
      async () => {
        const again = (await (await fetch(`${BASE}/api/tasks`)).json()) as {
          tasks: { id: number }[];
        };
        return again.tasks.some((t) => t.id === taskId);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});

async function currentStart(): Promise<string> {
  const monday = getMonday(new Date());
  const res = await fetch(`${BASE}/api/week?start=${monday}`);
  const payload = (await res.json()) as {
    placements: { time_entry_id: number; start_at: string }[];
  };
  return payload.placements.find((p) => p.time_entry_id === placementId)!.start_at;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/projects`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('GUI server did not start');
}

function localISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMonday(d: Date): string {
  const dt = new Date(d);
  const day = dt.getDay();
  dt.setDate(dt.getDate() - day + (day === 0 ? -6 : 1));
  return localISODate(dt);
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localISODate(d);
}
