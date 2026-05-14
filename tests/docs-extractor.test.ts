import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'dist', 'src', 'gui', 'public', 'docs.json');

describe('extract-docs.mjs', () => {
  beforeAll(() => {
    execSync('node scripts/extract-docs.mjs', { cwd: ROOT, stdio: 'pipe' });
  });

  it('writes docs.json with all four sections', () => {
    expect(existsSync(OUT)).toBe(true);
    const docs = JSON.parse(readFileSync(OUT, 'utf8'));
    expect(Array.isArray(docs.modules)).toBe(true);
    expect(Array.isArray(docs.tools)).toBe(true);
    expect(Array.isArray(docs.endpoints)).toBe(true);
    expect(Array.isArray(docs.tables)).toBe(true);
  });

  it('extracts every MCP tool by name', () => {
    const docs = JSON.parse(readFileSync(OUT, 'utf8'));
    const names = docs.tools.map((t: any) => t.name);
    for (const expected of [
      'create_task',
      'update_task',
      'place_task',
      'log_time',
      'get_week_layout',
      'list_projects',
      'sync_calendar_events',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('captures TSDoc summary on seeded tools', () => {
    const docs = JSON.parse(readFileSync(OUT, 'utf8'));
    const createTask = docs.tools.find((t: any) => t.name === 'create_task');
    expect(createTask?.summary).toMatch(/Create a task in a project/i);
    expect(createTask?.examples?.length ?? 0).toBeGreaterThan(0);
    expect(createTask?.seeAlso ?? []).toContain('place_task');
  });

  it('captures module-level summaries for seeded modules', () => {
    const docs = JSON.parse(readFileSync(OUT, 'utf8'));
    const serverMod = docs.modules.find(
      (m: any) => m.path === 'src/mcp/server.ts',
    );
    expect(serverMod?.summary).toMatch(/MCP stdio server/i);
  });

  it('extracts /api endpoints from gui/server.ts', () => {
    const docs = JSON.parse(readFileSync(OUT, 'utf8'));
    const paths = docs.endpoints.map((e: any) => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /api/projects');
    expect(paths).toContain('GET /api/week');
    expect(paths).toContain('GET /api/docs');
  });

  it('extracts every table from schema.sql', () => {
    const docs = JSON.parse(readFileSync(OUT, 'utf8'));
    const names = docs.tables.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'projects',
        'tasks',
        'time_log',
        'habits',
        'habit_instances',
        'calendar_events',
        'inbox',
        'time_policies',
      ]),
    );
    const tasks = docs.tables.find((t: any) => t.name === 'tasks');
    expect(tasks.columns.find((c: any) => c.name === 'id')?.primaryKey).toBe(
      true,
    );
    expect(
      tasks.columns.find((c: any) => c.name === 'project_id')?.references,
    ).toBe('projects.id');
  });

  it('every table in docs.json exists in a freshly-migrated DB with the same columns', async () => {
    // Closes the loop: what the extractor reports must match what SQLite
    // actually creates from schema.sql. If migrations diverge from the
    // schema file (or someone adds an ALTER), this catches it.
    const { freshDb } = await import('./helpers/db.js');
    const db = freshDb();
    const docs = JSON.parse(readFileSync(OUT, 'utf8'));

    const liveTables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    for (const t of docs.tables) {
      expect(liveTables).toContain(t.name);
      const liveCols = (
        db.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      const docCols = t.columns.map((c: any) => c.name);
      expect(liveCols.sort()).toEqual(docCols.slice().sort());
    }
    db.close();
  });
});
