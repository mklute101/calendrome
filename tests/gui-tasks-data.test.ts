import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createTask, setTaskStatus } from '../src/tasks.js';
import { buildTasksPayload } from '../src/gui/tasks-data.js';

/**
 * GUI tasks payload tests (#85).
 *
 * `/api/tasks` lists pending/unfinished tasks only (NEW, IN_PROGRESS,
 * SCHEDULED), ordered by priority then due date. COMPLETE and ARCHIVED
 * are excluded.
 */

function setup() {
  const db = freshDb();
  createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
  return db;
}

describe('buildTasksPayload', () => {
  it('excludes COMPLETE and ARCHIVED tasks', () => {
    const db = setup();
    const done = createTask(db, { project_id: 'acme', title: 'Done' });
    const archived = createTask(db, { project_id: 'acme', title: 'Archived' });
    createTask(db, { project_id: 'acme', title: 'Still open' });
    setTaskStatus(db, done.id, 'COMPLETE');
    setTaskStatus(db, archived.id, 'ARCHIVED');

    const { tasks } = buildTasksPayload(db);
    const titles = tasks.map((t) => t.title);
    expect(titles).toContain('Still open');
    expect(titles).not.toContain('Done');
    expect(titles).not.toContain('Archived');
  });

  it('includes all three pending statuses', () => {
    const db = setup();
    const a = createTask(db, { project_id: 'acme', title: 'New one' });
    const b = createTask(db, { project_id: 'acme', title: 'Scheduled one' });
    const c = createTask(db, { project_id: 'acme', title: 'Active one' });
    setTaskStatus(db, b.id, 'SCHEDULED');
    setTaskStatus(db, c.id, 'IN_PROGRESS');

    const { tasks } = buildTasksPayload(db);
    expect(tasks.map((t) => t.title).sort()).toEqual(
      ['Active one', 'New one', 'Scheduled one'].sort(),
    );
  });

  it('orders CRITICAL before LOW priority', () => {
    const db = setup();
    createTask(db, { project_id: 'acme', title: 'Low task', priority: 'LOW' });
    createTask(db, { project_id: 'acme', title: 'Critical task', priority: 'CRITICAL' });

    const { tasks } = buildTasksPayload(db);
    expect(tasks[0].title).toBe('Critical task');
    expect(tasks[tasks.length - 1].title).toBe('Low task');
  });

  it('within a priority, orders by earliest due (nulls last)', () => {
    const db = setup();
    createTask(db, { project_id: 'acme', title: 'No due', priority: 'HIGH' });
    createTask(db, { project_id: 'acme', title: 'Later', priority: 'HIGH', due: '2026-06-20T00:00:00Z' });
    createTask(db, { project_id: 'acme', title: 'Sooner', priority: 'HIGH', due: '2026-06-16T00:00:00Z' });

    const { tasks } = buildTasksPayload(db);
    expect(tasks.map((t) => t.title)).toEqual(['Sooner', 'Later', 'No due']);
  });
});
