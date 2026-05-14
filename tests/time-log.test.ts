import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createTask, getTask } from '../src/tasks.js';
import { completeTask, logTime } from '../src/time-log.js';

function setup() {
  const db = freshDb();
  createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
  return db;
}

describe('time log', () => {
  it('completeTask marks the task COMPLETE', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    const done = completeTask(db, t.id);
    expect(done.status).toBe('COMPLETE');
  });

  it('completeTask throws on unknown task_id', () => {
    const db = setup();
    expect(() => completeTask(db, 9999)).toThrow(/not found/);
  });

  describe('logTime (retroactive)', () => {
    it('inserts a CONFIRMED time_entry row with computed actual_minutes', () => {
      const db = setup();
      const t = createTask(db, { project_id: 'acme', title: 'Sprint planning' });

      const entry = logTime(db, {
        task_id: t.id,
        started_at: '2026-05-04T09:00:00-05:00',
        stopped_at: '2026-05-04T12:00:00-05:00',
        notes: 'with the team',
      });

      expect(entry.task_id).toBe(t.id);
      expect(entry.project_id).toBe('acme');
      expect(entry.duration_minutes).toBe(180);
      expect(entry.notes).toBe('with the team');

      const row = db
        .prepare('SELECT * FROM time_entry WHERE id = ?')
        .get(entry.id) as {
          task_id: number | null;
          project_id: string | null;
          actual_minutes: number;
          status: string;
          source: string;
          confirmed_at: string | null;
          notes: string | null;
        };
      expect(row.task_id).toBe(t.id);
      expect(row.project_id).toBe('acme');
      expect(row.actual_minutes).toBe(180);
      expect(row.status).toBe('CONFIRMED');
      expect(row.source).toBe('manual');
      expect(row.confirmed_at).toBeTruthy();
      expect(row.notes).toBe('with the team');

      // Status is independent of time_entry inserts
      const reread = getTask(db, t.id);
      expect(reread!.status).toBe('NEW');
    });

    it('allows task_id omitted with project_id supplied (project-only retro)', () => {
      const db = setup();

      const entry = logTime(db, {
        project_id: 'acme',
        started_at: '2026-05-04T09:00:00Z',
        stopped_at: '2026-05-04T10:00:00Z',
        notes: 'admin',
      });

      expect(entry.task_id).toBeNull();
      expect(entry.project_id).toBe('acme');
      expect(entry.duration_minutes).toBe(60);

      const row = db
        .prepare('SELECT task_id, project_id, status, source FROM time_entry WHERE id = ?')
        .get(entry.id) as {
          task_id: number | null;
          project_id: string | null;
          status: string;
          source: string;
        };
      expect(row.task_id).toBeNull();
      expect(row.project_id).toBe('acme');
      expect(row.status).toBe('CONFIRMED');
      expect(row.source).toBe('manual');
    });

    it('rejects when neither task_id nor project_id supplied', () => {
      const db = setup();
      expect(() =>
        logTime(db, {
          started_at: '2026-05-04T09:00:00Z',
          stopped_at: '2026-05-04T10:00:00Z',
        }),
      ).toThrow(/either task_id or project_id/);
    });

    it('rejects inverted timestamps (stopped_at <= started_at)', () => {
      const db = setup();
      const t = createTask(db, { project_id: 'acme', title: 'X' });

      expect(() =>
        logTime(db, {
          task_id: t.id,
          started_at: '2026-05-04T12:00:00Z',
          stopped_at: '2026-05-04T09:00:00Z',
        }),
      ).toThrow(/strictly after/);

      // Equal is also rejected (zero-duration entries are noise)
      expect(() =>
        logTime(db, {
          task_id: t.id,
          started_at: '2026-05-04T10:00:00Z',
          stopped_at: '2026-05-04T10:00:00Z',
        }),
      ).toThrow(/strictly after/);
    });

    it('rejects timestamps more than 24h in the future', () => {
      const db = setup();
      const t = createTask(db, { project_id: 'acme', title: 'X' });

      const farFuture = new Date(
        Date.now() + 48 * 60 * 60 * 1000,
      ).toISOString();
      const closer = new Date(
        Date.now() + 47 * 60 * 60 * 1000,
      ).toISOString();
      expect(() =>
        logTime(db, {
          task_id: t.id,
          started_at: closer,
          stopped_at: farFuture,
        }),
      ).toThrow(/24h in the future/);
    });

    it('rejects unparseable ISO strings', () => {
      const db = setup();
      const t = createTask(db, { project_id: 'acme', title: 'X' });

      expect(() =>
        logTime(db, {
          task_id: t.id,
          started_at: 'not a date',
          stopped_at: '2026-05-04T12:00:00Z',
        }),
      ).toThrow(/started_at is not a valid/);
    });

    it('rejects unknown task_id', () => {
      const db = setup();
      expect(() =>
        logTime(db, {
          task_id: 9999,
          started_at: '2026-05-04T09:00:00Z',
          stopped_at: '2026-05-04T10:00:00Z',
        }),
      ).toThrow(/not found/);
    });
  });
});
