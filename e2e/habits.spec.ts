import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end habit lifecycle (#129, #138): a fixed-days habit's
 * instance drags to another day of its week, and a habit under its
 * weekly target is offered by the empty-slot picker with "N left".
 * Exercises useTimelineDrag / PlacePicker → POST
 * /api/habit-instances[/:id/move] → SQLite.
 */

const PORT = 3923;
const BASE = `http://127.0.0.1:${PORT}`;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

let dir: string;
let server: ChildProcess;
let fixedId: number;
let targetId: number;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'calendrome-e2e-habits-'));
  const dbPath = join(dir, 'calendrome.db');

  const { openDatabase } = await import('../dist/src/db/connection.js');
  const { migrate } = await import('../dist/src/db/migrate.js');
  const { createHabit } = await import('../dist/src/habits.js');

  const db = openDatabase(dbPath);
  migrate(db);
  db.prepare(`INSERT INTO projects (id, name, prefix, color) VALUES ('acme', 'Acme', 'ACME', '#58a6ff')`).run();
  // Monday-only, 09:00 in the browser's zone so the block renders
  // where the grid expects it.
  fixedId = createHabit(db, {
    project_id: 'acme', title: 'Monday stretch', duration_minutes: 60,
    days_of_week: '1', start_time: '09:00', timezone: TZ,
  }).id;
  targetId = createHabit(db, {
    project_id: 'acme', title: 'Weekly read', duration_minutes: 30,
    times_per_week: 1, start_time: '13:00', timezone: TZ,
  }).id;
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

test('a fixed-days habit instance drags to another day of its week', async ({ page }) => {
  await page.goto(BASE);
  const block = page.locator('.timeline-block.habit', { hasText: 'Monday stretch' });
  await expect(block).toBeVisible();
  const from = (await block.boundingBox())!;
  const target = (await page.locator('.timeline-day .timeline-body').nth(2).boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, from.y + 40, { steps: 8 });
  await page.mouse.move(target.x + target.width / 2, from.y + 48, { steps: 4 });
  await page.mouse.up();

  await expect(page.locator('.toast', { hasText: 'Moved' })).toBeVisible();
  await expect
    .poll(async () => {
      const inst = (await habitInstances()).find((h) => h.habit_id === fixedId);
      return inst ? new Date(inst.start_at).getDay() : null;
    }, { timeout: 10_000 })
    .toBe(3); // Wednesday
});

test('the picker offers a habit under target and places it', async ({ page }) => {
  // Skip the generated candidate so the week has one slot left.
  await page.goto(BASE);
  const generated = (await habitInstances()).find((h) => h.habit_id === targetId)!;
  const skip = await fetch(`${BASE}/api/habit-instances/${generated.id}/skip`, { method: 'POST' });
  expect(skip.ok).toBe(true);

  await page.reload();
  const body = page.locator('.timeline-day .timeline-body').nth(4);
  const box = (await body.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 300);
  const row = page.locator('.place-picker-row', { hasText: 'Weekly read' });
  await expect(row).toContainText('1 left');
  await row.click();

  await expect
    .poll(async () =>
      (await habitInstances()).filter((h) => h.habit_id === targetId && h.status === 'PLANNED').length,
    { timeout: 10_000 })
    .toBe(1);

  // At target again: the picker no longer offers it.
  await page.mouse.click(box.x + box.width / 2, box.y + 500);
  await expect(page.locator('.place-picker')).toBeVisible();
  await expect(page.locator('.place-picker-row', { hasText: 'Weekly read' })).toHaveCount(0);
});

// ---- helpers ----

interface InstanceRow {
  id: number;
  habit_id: number;
  status: string;
  start_at: string;
}

async function habitInstances(): Promise<InstanceRow[]> {
  const res = await fetch(`${BASE}/api/week?start=${getMonday(new Date())}`);
  const payload = (await res.json()) as { habit_instances: InstanceRow[] };
  return payload.habit_instances;
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

function getMonday(d: Date): string {
  const dt = new Date(d);
  const day = dt.getDay();
  dt.setDate(dt.getDate() - day + (day === 0 ? -6 : 1));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
