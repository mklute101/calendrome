import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { callTool } from '../src/mcp/call-tool.js';
import { FakeCalendarClient } from '../src/calendar/index.js';

/**
 * Regression tests for #90: the MCP server must never serve a stale
 * view of the shared DB file. `callTool` opens a fresh connection per
 * call, so writes from other processes — and even wholesale file
 * replacement (backup/restore) — are visible on the very next call.
 *
 * These tests need real file-backed databases (the bug is about
 * cross-connection visibility), so they use a temp dir instead of the
 * usual in-memory `freshDb()`.
 */
describe('callTool per-call connections (#90)', () => {
  let dir: string;
  let dbPath: string;
  const calendar = new FakeCalendarClient();

  const parse = (r: { content: { text: string }[] }) =>
    JSON.parse(r.content[0].text);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'calendrome-test-'));
    dbPath = join(dir, 'calendrome.db');
    const boot = openDatabase(dbPath);
    migrate(boot);
    boot.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sees writes made through a different connection between calls', async () => {
    const before = await callTool(dbPath, calendar, 'list_projects', {});
    expect(parse(before).projects).toHaveLength(0);

    // Simulate a second MCP session (separate process, separate
    // connection) writing to the same file.
    const other = openDatabase(dbPath);
    other
      .prepare(`INSERT INTO projects (id, name, prefix) VALUES ('ACME', 'Acme', 'ACME')`)
      .run();
    other.close();

    const after = await callTool(dbPath, calendar, 'list_projects', {});
    const { projects } = parse(after);
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe('ACME');
  });

  it('sees the new file after the DB is atomically replaced (backup/restore)', async () => {
    // Populate the original DB.
    const orig = openDatabase(dbPath);
    orig
      .prepare(`INSERT INTO projects (id, name, prefix) VALUES ('OLD', 'Old', 'OLD')`)
      .run();
    orig.close();
    expect(parse(await callTool(dbPath, calendar, 'list_projects', {})).projects[0].id).toBe('OLD');

    // Build a replacement DB and rename it over the original — the
    // restore-from-backup flow. Clear WAL sidecars first, as a real
    // restore would.
    const replacementPath = join(dir, 'restore.db');
    const replacement = openDatabase(replacementPath);
    migrate(replacement);
    replacement
      .prepare(`INSERT INTO projects (id, name, prefix) VALUES ('NEW', 'New', 'NEW')`)
      .run();
    replacement.close();
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
    renameSync(replacementPath, dbPath);

    // A boot-time connection would still be reading the old inode
    // here; a per-call connection opens the path fresh.
    const { projects } = parse(await callTool(dbPath, calendar, 'list_projects', {}));
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe('NEW');
  });

  it('closes its connection even when the handler throws', async () => {
    const result = await callTool(dbPath, calendar, 'log_time', {});
    expect(result.isError).toBe(true);

    // If the failed call leaked its connection, the exclusive-lock
    // probe below would block/fail; a clean close leaves the file
    // free for other openers.
    const probe = openDatabase(dbPath);
    expect(() => probe.pragma('locking_mode = exclusive')).not.toThrow();
    probe.prepare('SELECT COUNT(*) AS n FROM projects').get();
    probe.close();
  });

  it('returns isError for an unknown tool without leaving a connection open', async () => {
    const result = await callTool(dbPath, calendar, 'no_such_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unknown tool/);
  });
});
