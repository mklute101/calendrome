import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { runMigration } from '../scripts/migrate-to-time-entry.js';

/**
 * Seed a DB that still has the legacy tables (time_log, calendar_events)
 * AND the new time_entry table. The current migrate() in src/db/migrate.ts
 * leaves both in place — schema.sql cleanup is Task 19.
 */
function seededLegacyDb() {
  const db = freshDb();
  db.exec(`INSERT INTO projects (id, name, prefix) VALUES ('A', 'A', 'A')`);
  db.exec(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'A', 't')`);
  db.exec(`
    INSERT INTO time_log (task_id, started_at, stopped_at, duration_minutes)
    VALUES (1, '2026-03-01T09:00:00Z', '2026-03-01T11:00:00Z', 120)
  `);
  db.exec(`
    INSERT INTO calendar_events (id, calendar_id, project_id, summary, start, end, duration_minutes, is_meeting, synced_at)
    VALUES ('evt-future', 'cal-a', 'A', 'Future meeting', '2099-01-01T09:00:00Z', '2099-01-01T10:00:00Z', 60, 1, datetime('now'))
  `);
  return db;
}

describe('migrate-to-time-entry', () => {
  it('copies CONFIRMED historical hours from time_log', () => {
    const db = seededLegacyDb();
    runMigration(db);
    const confirmed = db
      .prepare(`SELECT * FROM time_entry WHERE status='CONFIRMED' AND source='manual'`)
      .all() as any[];
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].actual_minutes).toBe(120);
    expect(confirmed[0].task_id).toBe(1);
    expect(confirmed[0].project_id).toBe('A');
  });

  it('preserves per-project CONFIRMED hour totals (parity)', () => {
    const db = seededLegacyDb();
    runMigration(db);
    const total = db
      .prepare(
        `SELECT CAST(SUM(COALESCE(actual_minutes, ROUND((julianday(end_at)-julianday(start_at))*1440))) AS INTEGER) AS m
         FROM time_entry WHERE status='CONFIRMED' AND source='manual'`,
      )
      .get() as { m: number };
    expect(total.m).toBe(120);
  });

  it('migrates future gcal-sync events as UNCONFIRMED with external_id preserved', () => {
    const db = seededLegacyDb();
    runMigration(db);
    const row = db
      .prepare(`SELECT external_id, status, source, is_meeting FROM time_entry WHERE external_id = 'evt-future'`)
      .get() as any;
    expect(row).toBeDefined();
    expect(row.status).toBe('UNCONFIRMED');
    expect(row.source).toBe('gcal-sync');
    expect(row.is_meeting).toBe(1);
  });

  it('drops legacy tables and columns', () => {
    const db = seededLegacyDb();
    runMigration(db);
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name='time_log'`).get(),
    ).toBeUndefined();
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name='calendar_events'`).get(),
    ).toBeUndefined();
    const cols = db.prepare(`PRAGMA table_info('tasks')`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('time_spent_minutes');
    expect(names).not.toContain('calendar_event_id');
  });

  it('is idempotent on second run', () => {
    const db = seededLegacyDb();
    runMigration(db);
    const beforeCount = (db.prepare(`SELECT COUNT(*) AS n FROM time_entry`).get() as any).n;
    runMigration(db);
    const afterCount = (db.prepare(`SELECT COUNT(*) AS n FROM time_entry`).get() as any).n;
    expect(afterCount).toBe(beforeCount);
  });

  it('throws parity error if confirmed totals diverge', () => {
    const db = seededLegacyDb();
    db.exec(`INSERT INTO projects (id, name, prefix) VALUES ('B', 'B', 'B')`);
    db.exec(`INSERT INTO tasks (id, project_id, title) VALUES (2, 'B', 't2')`);
    db.exec(`
      INSERT INTO time_log (task_id, started_at, stopped_at, duration_minutes)
      VALUES (2, '2026-03-01T09:00:00Z', '2026-03-01T10:00:00Z', 60)
    `);
    // Pre-insert into time_entry for project B with WRONG total
    db.prepare(
      `INSERT INTO time_entry (task_id, project_id, start_at, end_at, actual_minutes, status, confirmed_at, source)
       VALUES (2, 'B', '2026-03-01T09:00:00Z', '2026-03-01T10:00:00Z', 999, 'CONFIRMED', '2026-03-01T10:00:00Z', 'manual')`,
    ).run();
    expect(() => runMigration(db)).toThrow(/parity/i);

    // Transaction rolled back — legacy tables still present
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name='time_log'`).get(),
    ).toBeDefined();
  });
});
