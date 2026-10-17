import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DB } from '../src/db/connection.js';
import { migrate, preFoldBackupPath } from '../src/db/migrate.js';

/** A file DB with the pre-#173 projects table (cap in the column). */
function legacyFile(dir: string): string {
  const path = join(dir, 'calendrome.db');
  const db = openDatabase(path);
  migrate(db); // current schema...
  db.exec('ALTER TABLE projects ADD COLUMN weekly_budget_minutes INTEGER'); // ...plus the old column
  db.prepare(
    "INSERT INTO projects (id, name, prefix, weekly_budget_minutes) VALUES ('acme', 'Acme', 'ACME', 600)",
  ).run();
  db.close();
  return path;
}

const hasColumn = (db: DB) =>
  (db.prepare("PRAGMA table_info('projects')").all() as { name: string }[]).some(
    (c) => c.name === 'weekly_budget_minutes',
  );

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'calendrome-fold-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('M5 fold: backup before the irreversible drop (#173 review)', () => {
  it('writes <db>.pre-173.bak holding the legacy column, then folds', () => {
    const path = legacyFile(tmp());
    const db = openDatabase(path);
    migrate(db);
    expect(hasColumn(db)).toBe(false);
    db.close();

    const backupPath = `${path}.pre-173.bak`;
    expect(existsSync(backupPath)).toBe(true);
    const backup = openDatabase(backupPath);
    expect(hasColumn(backup)).toBe(true);
    expect(backup.prepare("SELECT weekly_budget_minutes AS m FROM projects WHERE id = 'acme'").get()).toEqual({ m: 600 });
    backup.close();
  });

  it('never overwrites an existing backup', () => {
    const path = legacyFile(tmp());
    const backupPath = `${path}.pre-173.bak`;
    writeFileSync(backupPath, 'an older backup');
    const db = openDatabase(path);
    migrate(db);
    expect(hasColumn(db)).toBe(false);
    db.close();
    expect(readFileSync(backupPath, 'utf8')).toBe('an older backup');
  });

  it('writes no backup for :memory: or for a DB that is already folded', () => {
    expect(preFoldBackupPath(openDatabase(':memory:'))).toBeNull();
    const path = join(tmp(), 'fresh.db');
    const db = openDatabase(path);
    migrate(db);
    migrate(db);
    db.close();
    expect(existsSync(`${path}.pre-173.bak`)).toBe(false);
  });
});

describe('M5 fold: the backup never lands in the public repo (#173 review round 2)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const inGit = (() => {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!inGit)('git ignores the backup of the default repo-root DB and of the demo DB', () => {
    for (const db of ['calendrome.db', 'demo/calendrome-demo.db']) {
      const backup = `${db}.pre-173.bak`;
      // Same naming rule the migration uses.
      expect(preFoldBackupPath({ memory: false, name: db } as unknown as DB)).toBe(backup);
      // Exits non-zero (throws) when the path is not ignored.
      expect(() =>
        execFileSync('git', ['check-ignore', '-q', backup], { cwd: repoRoot, stdio: 'ignore' }),
      ).not.toThrow();
    }
  });
});

describe('habit_instances.time_entry_id index (#173 review round 3)', () => {
  it('migrate() creates it idempotently and the credited-elsewhere EXISTS uses it', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    migrate(db);
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'habit_instances'")
      .all() as { name: string }[];
    expect(idx.map((r) => r.name)).toContain('idx_habit_instances_time_entry');
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT 1 FROM habit_instances hi WHERE hi.time_entry_id = ?')
      .all(1) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/idx_habit_instances_time_entry/);
  });
});

describe('M5 fold: concurrent boots (#173 review)', () => {
  it('two connections migrating the same file back to back both succeed, one fold', () => {
    const path = legacyFile(tmp());
    const a = openDatabase(path);
    const b = openDatabase(path);
    // Both connections exist (and have read the schema) before either migrates.
    expect(hasColumn(a)).toBe(true);
    expect(hasColumn(b)).toBe(true);
    expect(() => migrate(a)).not.toThrow();
    expect(() => migrate(b)).not.toThrow();
    expect(hasColumn(b)).toBe(false);
    expect(
      b.prepare("SELECT minutes FROM assignments WHERE envelope_id = 'acme' AND week_start = 'standing'").all(),
    ).toEqual([{ minutes: 600 }]);
    a.close();
    b.close();
  });

  it('connections carry a busy timeout so a concurrent boot waits', () => {
    const db = openDatabase(join(tmp(), 'x.db'));
    expect(db.pragma('busy_timeout', { simple: true })).toBeGreaterThan(0);
    db.close();
  });
});
