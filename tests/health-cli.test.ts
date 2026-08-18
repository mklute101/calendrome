import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createHabit } from '../src/habits.js';

/**
 * Exit-code contract of scripts/check-health.mjs (#164 follow-up):
 * 0 on a healthy database, 1 with FAIL lines on a violated
 * invariant, 2 when the database path does not exist. Spawns the
 * script against the BUILT modules, so this suite is skipped when
 * dist/ is absent — run `npm run build` first (same posture as
 * tests/otel-smoke.test.ts).
 */
const SCRIPT = join(process.cwd(), 'scripts', 'check-health.mjs');
const DIST = join(process.cwd(), 'dist', 'src', 'health', 'checks.js');

function run(dbPath: string) {
  const env = { ...process.env, CALENDROME_DB: dbPath };
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
}

describe.skipIf(!existsSync(DIST))('check-health CLI', () => {
  it('exits 0 with an ok line on a healthy database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendrome-health-cli-'));
    try {
      const dbPath = join(dir, 'clean.db');
      const db = openDatabase(dbPath);
      migrate(db);
      db.close();

      const result = run(dbPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^ok — \d+ checks passed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 and names the failing check on a corrupted database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendrome-health-cli-'));
    try {
      const dbPath = join(dir, 'corrupt.db');
      const db = openDatabase(dbPath);
      migrate(db);
      db.prepare(
        `INSERT INTO projects (id, name, prefix) VALUES ('acme', 'Acme', 'ACME')`,
      ).run();
      createHabit(db, {
        project_id: 'acme',
        title: 'Morning run',
        duration_minutes: 30,
        days_of_week: '1,3,5',
        start_time: '07:00',
        // timezone omitted -> schema default 'UTC' leaks through
      });
      db.close();

      const result = run(dbPath);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL habit_timezone_not_utc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when the database path does not exist', () => {
    const result = run(join(tmpdir(), 'calendrome-no-such-db', 'nope.db'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('database not found');
  });
});
