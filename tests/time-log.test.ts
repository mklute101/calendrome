import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createTask, getTask } from '../src/tasks.js';
import { startTask, stopTask, completeTask } from '../src/time-log.js';

function setup() {
  const db = freshDb();
  createProject(db, { id: 'san', name: 'SAN', prefix: 'SAN' });
  return db;
}

describe('time log', () => {
  it('startTask creates an open log row and sets status IN_PROGRESS', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'san', title: 'X' });
    const entry = startTask(db, t.id);
    expect(entry.task_id).toBe(t.id);
    expect(entry.started_at).toBeTruthy();
    expect(entry.stopped_at).toBeNull();

    const reread = getTask(db, t.id);
    expect(reread!.status).toBe('IN_PROGRESS');
  });

  it('throws when starting an already-running task', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'san', title: 'X' });
    startTask(db, t.id);
    expect(() => startTask(db, t.id)).toThrow();
  });

  it('stopTask closes the row, computes duration, and increments time_spent', async () => {
    const db = setup();
    const t = createTask(db, { project_id: 'san', title: 'X' });
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
    const t = createTask(db, { project_id: 'san', title: 'X' });
    startTask(db, t.id);
    const done = completeTask(db, t.id);
    expect(done.status).toBe('COMPLETE');
  });

  it('multiple start/stop cycles accumulate time_spent_minutes', async () => {
    const db = setup();
    const t = createTask(db, { project_id: 'san', title: 'X' });
    startTask(db, t.id);
    await new Promise((r) => setTimeout(r, 1100));
    const first = stopTask(db, t.id);

    startTask(db, t.id);
    await new Promise((r) => setTimeout(r, 1100));
    const second = stopTask(db, t.id);

    const reread = getTask(db, t.id);
    expect(reread!.time_spent_minutes).toBe(
      first.duration_minutes + second.duration_minutes,
    );
  });
});
