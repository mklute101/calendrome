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
    it('inserts a closed row, computes duration, bumps time_spent_minutes', () => {
      const db = setup();
      const t = createTask(db, { project_id: 'acme', title: 'Sprint planning' });

      const entry = logTime(db, {
        task_id: t.id,
        started_at: '2026-05-04T09:00:00-05:00',
        stopped_at: '2026-05-04T12:00:00-05:00',
        notes: 'with the team',
      });

      expect(entry.task_id).toBe(t.id);
      expect(entry.stopped_at).toBeTruthy();
      expect(entry.duration_minutes).toBe(180);
      expect(entry.notes).toBe('with the team');

      const reread = getTask(db, t.id);
      expect(reread!.time_spent_minutes).toBe(180);
      // Status is independent of time_log inserts
      expect(reread!.status).toBe('NEW');
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

    it('rejects entries that overlap an open timer on the same task', () => {
      const db = setup();
      const t = createTask(db, { project_id: 'acme', title: 'X' });

      // Live timer running from "now"
      startTask(db, t.id);

      // Retro entry that ends in the future overlaps the open timer
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      expect(() =>
        logTime(db, {
          task_id: t.id,
          started_at: past,
          stopped_at: future,
        }),
      ).toThrow(/open timer/);
    });

    it('allows retro entries that end before an open timer started', () => {
      const db = setup();
      const t = createTask(db, { project_id: 'acme', title: 'X' });

      // Open timer started "now". A retro entry from yesterday ending
      // before the timer started is fine — they don't overlap.
      startTask(db, t.id);

      const yesterdayStart = new Date(
        Date.now() - 25 * 60 * 60 * 1000,
      ).toISOString();
      const yesterdayEnd = new Date(
        Date.now() - 22 * 60 * 60 * 1000,
      ).toISOString();

      const entry = logTime(db, {
        task_id: t.id,
        started_at: yesterdayStart,
        stopped_at: yesterdayEnd,
      });
      expect(entry.duration_minutes).toBe(180);
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

    it('multiple non-overlapping retro entries accumulate time_spent_minutes', () => {
      const db = setup();
      const t = createTask(db, { project_id: 'acme', title: 'X' });

      logTime(db, {
        task_id: t.id,
        started_at: '2026-05-04T09:00:00Z',
        stopped_at: '2026-05-04T10:30:00Z',
      });
      logTime(db, {
        task_id: t.id,
        started_at: '2026-05-04T13:00:00Z',
        stopped_at: '2026-05-04T14:15:00Z',
      });

      const reread = getTask(db, t.id);
      expect(reread!.time_spent_minutes).toBe(90 + 75);
    });

    it('logged entries surface in get_timesheet_summary', async () => {
      const db = setup();
      const t = createTask(db, { project_id: 'acme', title: 'Sprint planning' });

      logTime(db, {
        task_id: t.id,
        started_at: '2026-05-04T09:00:00Z',
        stopped_at: '2026-05-04T12:00:00Z',
      });

      const { getTimesheetSummary } = await import('../src/timesheet.js');
      const summary = getTimesheetSummary(db, '2026-05-04', '2026-05-04');
      const acme = summary.by_project.find((p) => p.project === 'ACME');
      expect(acme?.total_hours).toBe(3);
      expect(summary.grand_total_hours).toBe(3);
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
