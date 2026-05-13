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
});
