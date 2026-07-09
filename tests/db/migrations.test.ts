import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';

describe('database migrations', () => {
  it('runs cleanly on a fresh database', () => {
    const db = openDatabase(':memory:');
    expect(() => migrate(db)).not.toThrow();
  });

  it('creates all expected tables', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = rows.map((r) => r.name);

    for (const t of [
      'projects',
      'tasks',
      'inbox',
      'time_entry',
      'time_policies',
      'habits',
      'habit_instances',
      'categories',
      'availability_overrides',
    ]) {
      expect(tableNames).toContain(t);
    }
    // Legacy tables removed in Task 19 — verify they're not present on fresh installs.
    expect(tableNames).not.toContain('time_log');
    expect(tableNames).not.toContain('calendar_events');
  });

  it('seeds work and personal categories', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const rows = db
      .prepare("SELECT id FROM categories ORDER BY id")
      .all() as { id: string }[];
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('work');
    expect(ids).toContain('personal');
  });

  it('adds category_id to projects and backfills to work', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const cols = db
      .prepare("PRAGMA table_info('projects')")
      .all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('category_id');

    db.prepare(
      "INSERT INTO projects (id, name, prefix) VALUES ('legacy', 'L', 'L')",
    ).run();
    // Simulate an older row by clearing the column then re-running migrate
    db.prepare("UPDATE projects SET category_id = NULL WHERE id = 'legacy'").run();
    migrate(db);
    const row = db
      .prepare("SELECT category_id FROM projects WHERE id = 'legacy'")
      .get() as { category_id: string };
    expect(row.category_id).toBe('work');
  });

  it('creates expected columns on projects', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const cols = db.prepare("PRAGMA table_info('projects')").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'prefix',
        'calendar_id',
        'color',
        'weekly_budget_minutes',
        'active',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('creates expected columns on tasks', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const cols = db.prepare("PRAGMA table_info('tasks')").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'project_id',
        'title',
        'notes',
        'priority',
        'status',
        'duration_minutes',
        'due',
        'snooze_until',
        'depends_on',
        'created_at',
        'updated_at',
      ]),
    );
    // Legacy columns removed in Task 19.
    expect(names).not.toContain('time_spent_minutes');
    expect(names).not.toContain('calendar_event_id');
  });

  it('creates expected columns on habits and habit_instances', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const habitCols = db.prepare("PRAGMA table_info('habits')").all() as { name: string }[];
    expect(habitCols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'id',
        'project_id',
        'title',
        'notes',
        'duration_minutes',
        'days_of_week',
        'start_time',
        'timezone',
        'active',
        'created_at',
      ]),
    );

    const instCols = db
      .prepare("PRAGMA table_info('habit_instances')")
      .all() as { name: string }[];
    expect(instCols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'id',
        'habit_id',
        'scheduled_start',
        'scheduled_end',
        'status',
        'calendar_event_id',
        'completed_at',
      ]),
    );
  });

  it('is idempotent when re-run', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });
});

describe('time_entry timestamp normalization (#95)', () => {
  const insertRaw = (db: any, start: string, end: string, confirmed: string | null = null, synced: string | null = null) => {
    const r = db.prepare(`
      INSERT INTO time_entry (start_at, end_at, status, source, confirmed_at, synced_at)
      VALUES (?, ?, 'UNCONFIRMED', 'placement', ?, ?)
    `).run(start, end, confirmed, synced);
    return Number(r.lastInsertRowid);
  };
  const getRow = (db: any, id: number) =>
    db.prepare(`SELECT * FROM time_entry WHERE id = ?`).get(id) as any;

  it('rewrites mixed-form rows to canonical UTC with durations unchanged', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    // The real-world mixed row from #95: local offset start, ms-UTC end.
    const a = insertRaw(db, '2026-07-06T11:15:00-05:00', '2026-07-06T19:15:00.000Z');
    // datetime('now')-style bare form in confirmed_at/synced_at.
    const b = insertRaw(db, '2026-07-06T09:00:00Z', '2026-07-06T10:00:00Z', '2026-07-06 10:00:00', '2026-07-06 10:05:00');

    migrate(db);

    const rowA = getRow(db, a);
    expect(rowA.start_at).toBe('2026-07-06T16:15:00Z');
    expect(rowA.end_at).toBe('2026-07-06T19:15:00Z');

    const rowB = getRow(db, b);
    expect(rowB.confirmed_at).toBe('2026-07-06T10:00:00Z');
    expect(rowB.synced_at).toBe('2026-07-06T10:05:00Z');
  });

  it('buckets a local-evening entry into its true UTC day', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    // 8pm Chicago on July 6 = 1am UTC July 7 — the #95 headline case.
    const id = insertRaw(db, '2026-07-06T20:00:00-05:00', '2026-07-06T21:30:00-05:00');
    migrate(db);

    const row = getRow(db, id);
    expect(row.start_at).toBe('2026-07-07T01:00:00Z');
    expect(row.end_at).toBe('2026-07-07T02:30:00Z');
    const day = db.prepare(`SELECT DATE(start_at) AS d FROM time_entry WHERE id = ?`).get(id) as any;
    expect(day.d).toBe('2026-07-07');
  });

  it('is idempotent: canonical rows are untouched on re-run', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    const id = insertRaw(db, '2026-07-06T09:00:00Z', '2026-07-06T10:00:00Z');
    const before = getRow(db, id);
    migrate(db);
    const after = getRow(db, id);
    expect(after).toEqual(before);
  });

  it('skips (does not abort on) a row that would violate end >= start once normalized', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    // Passes the CHECK lexicographically ('T11…' < 'T15…') but the true
    // instants are inverted: start = 16:30Z, end = 15:00Z.
    const bad = insertRaw(db, '2026-07-06T11:30:00-05:00', '2026-07-06T15:00:00Z');
    const good = insertRaw(db, '2026-07-06T11:15:00-05:00', '2026-07-06T19:15:00.000Z');

    expect(() => migrate(db)).not.toThrow();

    // Bad row left as-is; good row normalized.
    const badRow = getRow(db, bad);
    expect(badRow.start_at).toBe('2026-07-06T11:30:00-05:00');
    expect(badRow.end_at).toBe('2026-07-06T15:00:00Z');
    expect(getRow(db, good).start_at).toBe('2026-07-06T16:15:00Z');
  });
});
