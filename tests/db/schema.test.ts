import { describe, it, expect } from 'vitest';
import { freshDb } from '../helpers/db.js';

describe('time_entry schema', () => {
  it('creates time_entry table with required columns', () => {
    const db = freshDb();
    const cols = db.prepare("PRAGMA table_info('time_entry')").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id', 'task_id', 'project_id',
        'start_at', 'end_at', 'actual_minutes',
        'status', 'confirmed_at',
        'source', 'external_id', 'is_meeting', 'synced_at', 'harvest_entry_id',
        'notes', 'created_at', 'updated_at',
      ]),
    );
  });

  it('rejects invalid status values via CHECK constraint', () => {
    const db = freshDb();
    expect(() =>
      db.prepare(
        `INSERT INTO time_entry (start_at, end_at, status, source)
         VALUES (?, ?, ?, ?)`,
      ).run('2026-05-13T09:00:00Z', '2026-05-13T10:00:00Z', 'BOGUS', 'manual'),
    ).toThrow();
  });

  it('rejects invalid source values via CHECK constraint', () => {
    const db = freshDb();
    expect(() =>
      db.prepare(
        `INSERT INTO time_entry (start_at, end_at, status, source)
         VALUES (?, ?, ?, ?)`,
      ).run('2026-05-13T09:00:00Z', '2026-05-13T10:00:00Z', 'UNCONFIRMED', 'invalid_src'),
    ).toThrow();
  });

  it('creates v_task_time_spent view that sums CONFIRMED actual_minutes per task', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'Test', 'TEST')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'TEST', 'task')`).run();
    db.prepare(
      `INSERT INTO time_entry (task_id, project_id, start_at, end_at, actual_minutes, status, source)
       VALUES (1, 'TEST', '2026-05-13T09:00:00Z', '2026-05-13T10:00:00Z', 60, 'CONFIRMED', 'manual')`,
    ).run();
    db.prepare(
      `INSERT INTO time_entry (task_id, project_id, start_at, end_at, actual_minutes, status, source)
       VALUES (1, 'TEST', '2026-05-13T14:00:00Z', '2026-05-13T15:30:00Z', 90, 'CONFIRMED', 'manual')`,
    ).run();
    db.prepare(
      `INSERT INTO time_entry (task_id, project_id, start_at, end_at, actual_minutes, status, source)
       VALUES (1, 'TEST', '2026-05-14T09:00:00Z', '2026-05-14T10:00:00Z', 60, 'UNCONFIRMED', 'placement')`,
    ).run();

    const row = db.prepare(
      `SELECT minutes FROM v_task_time_spent WHERE task_id = 1`,
    ).get() as { minutes: number };
    expect(row.minutes).toBe(150); // UNCONFIRMED ignored
  });

  it('falls back to julianday duration and rounds when actual_minutes is NULL', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'Test', 'TEST')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'TEST', 'task')`).run();
    // 09:00 -> 10:30 = 90 minutes. julianday math yields 89.9999... so ROUND is required to get 90.
    db.prepare(
      `INSERT INTO time_entry (task_id, project_id, start_at, end_at, actual_minutes, status, source)
       VALUES (1, 'TEST', '2026-05-13T09:00:00Z', '2026-05-13T10:30:00Z', NULL, 'CONFIRMED', 'manual')`,
    ).run();
    const row = db.prepare(
      `SELECT minutes FROM v_task_time_spent WHERE task_id = 1`,
    ).get() as { minutes: number };
    expect(row.minutes).toBe(90);
  });

  it('allows multiple NULL external_id rows but enforces uniqueness on non-NULL values', () => {
    const db = freshDb();
    const insertNull = db.prepare(
      `INSERT INTO time_entry (start_at, end_at, status, source, external_id)
       VALUES (?, ?, 'UNCONFIRMED', 'manual', NULL)`,
    );
    expect(() => insertNull.run('2026-05-13T09:00:00Z', '2026-05-13T10:00:00Z')).not.toThrow();
    expect(() => insertNull.run('2026-05-13T11:00:00Z', '2026-05-13T12:00:00Z')).not.toThrow();

    const insertGcal = db.prepare(
      `INSERT INTO time_entry (start_at, end_at, status, source, external_id)
       VALUES (?, ?, 'UNCONFIRMED', 'gcal-sync', 'gcal-evt-1')`,
    );
    expect(() => insertGcal.run('2026-05-13T13:00:00Z', '2026-05-13T14:00:00Z')).not.toThrow();
    expect(() => insertGcal.run('2026-05-13T15:00:00Z', '2026-05-13T16:00:00Z')).toThrow();
  });

  it('excludes rows with task_id IS NULL from v_task_time_spent', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'Test', 'TEST')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'TEST', 'task')`).run();
    // Project-only / meeting row with task_id = NULL
    db.prepare(
      `INSERT INTO time_entry (task_id, project_id, start_at, end_at, actual_minutes, status, source, is_meeting)
       VALUES (NULL, 'TEST', '2026-05-13T09:00:00Z', '2026-05-13T10:00:00Z', 60, 'CONFIRMED', 'gcal-sync', 1)`,
    ).run();
    // Row tied to a task
    db.prepare(
      `INSERT INTO time_entry (task_id, project_id, start_at, end_at, actual_minutes, status, source)
       VALUES (1, 'TEST', '2026-05-13T11:00:00Z', '2026-05-13T11:30:00Z', 30, 'CONFIRMED', 'manual')`,
    ).run();

    const rows = db.prepare(`SELECT task_id, minutes FROM v_task_time_spent`).all() as
      { task_id: number | null; minutes: number }[];
    expect(rows).toEqual([{ task_id: 1, minutes: 30 }]);
  });

  it('rejects end_at < start_at via CHECK constraint', () => {
    const db = freshDb();
    expect(() =>
      db.prepare(
        `INSERT INTO time_entry (start_at, end_at, status, source)
         VALUES (?, ?, ?, ?)`,
      ).run('2026-05-13T10:00:00Z', '2026-05-13T09:00:00Z', 'UNCONFIRMED', 'manual'),
    ).toThrow();
  });

  it('rejects negative actual_minutes via CHECK constraint', () => {
    const db = freshDb();
    expect(() =>
      db.prepare(
        `INSERT INTO time_entry (start_at, end_at, actual_minutes, status, source)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('2026-05-13T09:00:00Z', '2026-05-13T10:00:00Z', -5, 'UNCONFIRMED', 'manual'),
    ).toThrow();
  });

  it('rejects is_meeting values outside (0, 1) via CHECK constraint', () => {
    const db = freshDb();
    expect(() =>
      db.prepare(
        `INSERT INTO time_entry (start_at, end_at, is_meeting, status, source)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('2026-05-13T09:00:00Z', '2026-05-13T10:00:00Z', 2, 'UNCONFIRMED', 'manual'),
    ).toThrow();
  });
});
