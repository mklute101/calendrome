import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Playground boot test: serve website/ statically (what Netlify does)
 * and assert the in-browser demo boots — sql.js WASM loads, the
 * schema applies, the seed runs, and the seeded projects render —
 * then exercise one write (complete a task) against the in-tab
 * database. Run `npm run build:playground` first; the suite fails
 * fast with a pointer if the bundle is missing.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBSITE = resolve(__dirname, '../website');
const PORT = 3922;
const BASE = `http://127.0.0.1:${PORT}`;

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

let server: Server;

test.beforeAll(async () => {
  if (!existsSync(join(WEBSITE, 'playground', 'index.html'))) {
    throw new Error(
      'website/playground/ not built — run `npm run build:playground` first',
    );
  }
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', BASE).pathname);
    let file = join(WEBSITE, path);
    if (existsSync(file) && statSync(file).isDirectory()) {
      file = join(file, 'index.html');
    }
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
});

test('boots on an in-browser DB and renders the seeded week', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(`${BASE}/playground/`);

  // Banner marks demo mode; budget cards prove schema + seed + week
  // payload all ran against the WASM database.
  await expect(page.locator('.playground-banner')).toBeVisible();
  await expect(page.locator('.budget-card')).toHaveCount(3);
  await expect(page.locator('body')).toContainText('acme');
  await expect(page.locator('body')).toContainText('globex');

  expect(pageErrors).toEqual([]);
});

test('writes hit the in-tab database (complete a task)', async ({ page }) => {
  await page.goto(`${BASE}/playground/`);
  await page.locator('.budget-card').first().waitFor();

  await page.click('button:has-text("Tasks")');
  const rows = page.locator('.task-row');
  const before = await rows.count();
  expect(before).toBeGreaterThan(0);

  await page
    .locator('.task-row .task-action[title="Mark complete"]')
    .first()
    .click();

  // The completed task leaves the pending list and a toast confirms.
  await expect(rows).toHaveCount(before - 1);
  await expect(page.locator('.toast')).toContainText('Completed');
});
