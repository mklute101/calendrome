import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end placement tests (#138): the timeline is the default
 * view, a task row dragged from the panel lands as a placement, a
 * goal row drags the same way, and clicking an empty slot opens the
 * picker — the no-drag path. Exercises pointer events →
 * useTimelineDrag / PlacePicker → POST /api/placements +
 * /api/goal-blocks → SQLite.
 */

const PORT = 3922;
const BASE = `http://127.0.0.1:${PORT}`;

let dir: string;
let server: ChildProcess;
let dragTaskId: number;
let pickTaskId: number;
let buttonTaskId: number;
let goalId: number;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'calendrome-e2e-place-'));
  const dbPath = join(dir, 'calendrome.db');

  const { openDatabase } = await import('../dist/src/db/connection.js');
  const { migrate } = await import('../dist/src/db/migrate.js');
  const { createTask } = await import('../dist/src/tasks.js');
  const { createGoal } = await import('../dist/src/goals.js');

  const db = openDatabase(dbPath);
  migrate(db);
  db.prepare(`INSERT INTO projects (id, name, prefix, color) VALUES ('acme', 'Acme', 'ACME', '#58a6ff')`).run();
  dragTaskId = createTask(db, {
    project_id: 'acme',
    title: 'Drag me task',
    duration_minutes: 60,
  }).id;
  pickTaskId = createTask(db, {
    project_id: 'acme',
    title: 'Pick me task',
    duration_minutes: 45,
  }).id;
  buttonTaskId = createTask(db, {
    project_id: 'acme',
    title: 'Complete me task',
    duration_minutes: 30,
  }).id;
  goalId = createGoal(db, {
    project_id: 'acme',
    title: 'Cert study',
    target_minutes: 1800,
    due: '2027-01-01',
    min_chunk_minutes: 30,
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

test('fresh profile lands on the timeline (interactive) view', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('.timeline-container')).toBeVisible();
});

test('dragging a task row from the panel places it', async ({ page }) => {
  await page.goto(BASE);
  await page.click('button:has-text("Tasks")');
  const row = page.locator('.task-row', { hasText: 'Drag me task' });
  await expect(row).toBeVisible();

  await dragToGrid(page, row.locator('.task-title'), 1);

  await expect
    .poll(() => findPlacement((p) => p.task_id === dragTaskId), { timeout: 10_000 })
    .not.toBeNull();
  const placement = await findPlacement((p) => p.task_id === dragTaskId);
  const start = new Date(placement!.start_at);
  expect(start.getMinutes() % 15).toBe(0); // snapped
  expect(placement!.duration_minutes).toBe(60);
  await expect(page.locator('.toast', { hasText: 'Placed' })).toBeVisible();
});

test('dragging a goal row places a min_chunk-sized block', async ({ page }) => {
  await page.goto(BASE);
  await page.click('button:has-text("Tasks")');
  const row = page.locator('.goal-item', { hasText: 'Cert study' });
  await expect(row).toBeVisible();

  await dragToGrid(page, row.locator('.task-title'), 2);

  await expect
    .poll(() => findPlacement((p) => p.goal_id === goalId), { timeout: 10_000 })
    .not.toBeNull();
  const placement = await findPlacement((p) => p.goal_id === goalId);
  expect(placement!.duration_minutes).toBe(30);
});

test('clicking an empty slot opens the picker; picking places; Escape closes', async ({ page }) => {
  await page.goto(BASE);
  const body = page.locator('.timeline-day .timeline-body').nth(3);
  const box = (await body.boundingBox())!;

  // Escape closes without placing.
  await page.mouse.click(box.x + box.width / 2, box.y + 180);
  await expect(page.locator('.place-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.place-picker')).toBeHidden();

  // Pick a task — it lands at the clicked slot.
  await page.mouse.click(box.x + box.width / 2, box.y + 180);
  await expect(page.locator('.place-picker')).toBeVisible();
  await page
    .locator('.place-picker-row', { hasText: 'Pick me task' })
    .click();
  await expect
    .poll(() => findPlacement((p) => p.task_id === pickTaskId), { timeout: 10_000 })
    .not.toBeNull();
  const placement = await findPlacement((p) => p.task_id === pickTaskId);
  expect(placement!.duration_minutes).toBe(45);
});

test('row action buttons still click without starting a drag', async ({ page }) => {
  await page.goto(BASE);
  await page.click('button:has-text("Tasks")');
  const row = page.locator('.task-row', { hasText: 'Complete me task' });
  await expect(row).toBeVisible();
  await row.locator('button[title="Mark complete"]').click();
  await expect(page.locator('.toast', { hasText: 'Completed' })).toBeVisible();
});

// ---- helpers ----

async function dragToGrid(
  page: Page,
  handle: ReturnType<Page['locator']>,
  dayIndex: number,
) {
  const from = (await handle.boundingBox())!;
  const target = page.locator('.timeline-day .timeline-body').nth(dayIndex);
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Multiple steps so the 4px threshold trips and the ghost tracks.
  await page.mouse.move(to.x + to.width / 2, to.y + 100, { steps: 8 });
  await page.mouse.move(to.x + to.width / 2, to.y + 150, { steps: 4 });
  await page.mouse.up();
}

interface PlacementRow {
  time_entry_id: number;
  task_id: number | null;
  goal_id: number | null;
  start_at: string;
  duration_minutes: number;
}

async function findPlacement(
  match: (p: PlacementRow) => boolean,
): Promise<PlacementRow | null> {
  const monday = getMonday(new Date());
  const res = await fetch(`${BASE}/api/week?start=${monday}`);
  const payload = (await res.json()) as { placements: PlacementRow[] };
  return payload.placements.find(match) ?? null;
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
