import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { preFoldBackupPath } from '../src/standing-assignments.js';

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
