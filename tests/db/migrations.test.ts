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
