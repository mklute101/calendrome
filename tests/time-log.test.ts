import { describe, it, expect, afterEach } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createTask, getTask } from '../src/tasks.js';
import { completeTask, logTime } from '../src/time-log.js';
import { FakeCalendarClient } from '../src/calendar/fake.js';
import { placeTask } from '../src/placement.js';

function setup() {
  const db = freshDb();
  createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
  return db;
}

describe('time log', () => {
  it('completeTask marks the task COMPLETE', async () => {
    const db = setup();
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    const done = await completeTask(db, new FakeCalendarClient(), t.id);
    expect(done.status).toBe('COMPLETE');
  });

  it('completeTask throws on unknown task_id', async () => {
    const db = setup();
    await expect(completeTask(db, new FakeCalendarClient(), 9999)).rejects.toThrow(/not found/);
  });

  describe('completeTask clears upcoming placements (#105)', () => {
    afterEach(() => {
      delete process.env.CALENDROME_NOW;
    });

    it('deletes still-upcoming UNCONFIRMED placements and their calendar events', async () => {
      // The #105 repro: task completed at ~8am, placement at 9am same day.
      process.env.CALENDROME_NOW = '2026-07-16T13:00:00Z';
      const db = setup();
      const calendar = new FakeCalendarClient();
      const t = createTask(db, { project_id: 'acme', title: 'finish/verify', duration_minutes: 30 });
      const placed = await placeTask(db, calendar, { task_id: t.id, start: '2026-07-16T14:00:00Z' });
      expect(calendar.events).toHaveLength(1);

      const done = await completeTask(db, calendar, t.id);
      expect(done.status).toBe('COMPLETE');
      const row = db.prepare(`SELECT id FROM time_entry WHERE id = ?`).get(placed.time_entry_id);
      expect(row).toBeUndefined();
      expect(calendar.events).toHaveLength(0);
    });

    it('leaves already-started placements for the EOD review', async () => {
      process.env.CALENDROME_NOW = '2026-07-16T15:00:00Z';
      const db = setup();
      const calendar = new FakeCalendarClient();
      const t = createTask(db, { project_id: 'acme', title: 'in flight', duration_minutes: 60 });
      const placed = await placeTask(db, calendar, { task_id: t.id, start: '2026-07-16T14:30:00Z' });

      await completeTask(db, calendar, t.id);
      const row = db
        .prepare(`SELECT status FROM time_entry WHERE id = ?`)
        .get(placed.time_entry_id) as { status: string };
      expect(row.status).toBe('UNCONFIRMED');
      expect(calendar.events).toHaveLength(1);
    });

    it('clears only the future placements of a split task', async () => {
      process.env.CALENDROME_NOW = '2026-07-16T15:00:00Z';
      const db = setup();
      const calendar = new FakeCalendarClient();
      const t = createTask(db, { project_id: 'acme', title: 'split', duration_minutes: 60 });
      const past = await placeTask(db, calendar, { task_id: t.id, start: '2026-07-16T13:00:00Z' });
      const future = await placeTask(db, calendar, { task_id: t.id, start: '2026-07-17T13:00:00Z' });

      await completeTask(db, calendar, t.id);
      expect(db.prepare(`SELECT id FROM time_entry WHERE id = ?`).get(past.time_entry_id)).toBeDefined();
      expect(db.prepare(`SELECT id FROM time_entry WHERE id = ?`).get(future.time_entry_id)).toBeUndefined();
      expect(calendar.events).toHaveLength(1);
    });
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

    it('rejects when none of task_id, project_id, goal_id supplied', () => {
      const db = setup();
      expect(() =>
        logTime(db, {
          started_at: '2026-05-04T09:00:00Z',
          stopped_at: '2026-05-04T10:00:00Z',
        }),
      ).toThrow(/one of task_id, project_id, or goal_id/);
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
