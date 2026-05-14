import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createTask, getTask } from '../src/tasks.js';
import { startTask, stopTask, completeTask, logTime } from '../src/time-log.js';

function setup() {
  const db = freshDb();
  createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
  return db;
}

describe('time log', () => {
  it('startTask creates an open log row and sets status IN_PROGRESS', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    const entry = startTask(db, t.id);
    expect(entry.task_id).toBe(t.id);
    expect(entry.started_at).toBeTruthy();
    expect(entry.stopped_at).toBeNull();

    const reread = getTask(db, t.id);
    expect(reread!.status).toBe('IN_PROGRESS');
  });

  it('throws when starting an already-running task', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    startTask(db, t.id);
    expect(() => startTask(db, t.id)).toThrow();
  });

  it('stopTask closes the row, computes duration, and increments time_spent', async () => {
    const db = setup();
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    startTask(db, t.id);
    await new Promise((r) => setTimeout(r, 1100));
    const entry = stopTask(db, t.id);
    expect(entry.stopped_at).toBeTruthy();
    expect(entry.duration_minutes).toBeGreaterThanOrEqual(0);

    const reread = getTask(db, t.id);
    expect(reread!.time_spent_minutes).toBe(entry.duration_minutes);
  });

  it('completeTask stops the timer if running and marks COMPLETE', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    startTask(db, t.id);
    const done = completeTask(db, t.id);
    expect(done.status).toBe('COMPLETE');
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

  it('multiple start/stop cycles accumulate time_spent_minutes', async () => {
    const db = setup();
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    startTask(db, t.id);
    await new Promise((r) => setTimeout(r, 1100));
    const first = stopTask(db, t.id);

    startTask(db, t.id);
    await new Promise((r) => setTimeout(r, 1100));
    const second = stopTask(db, t.id);

    expect(first.duration_minutes).not.toBeNull();
    expect(second.duration_minutes).not.toBeNull();
    const reread = getTask(db, t.id);
    expect(reread!.time_spent_minutes).toBe(
      first.duration_minutes! + second.duration_minutes!,
    );
  });
});
