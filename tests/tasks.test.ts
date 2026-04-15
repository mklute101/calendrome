import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import {
  createTask,
  getTask,
  updateTask,
  listTasks,
  searchTasks,
  deleteTask,
  setTaskStatus,
} from '../src/tasks.js';

function setup() {
  const db = freshDb();
  createProject(db, { id: 'san', name: 'SAN', prefix: 'SAN' });
  createProject(db, { id: 'mtb', name: 'MTB', prefix: 'MTB' });
  return db;
}

describe('tasks', () => {
  it('createTask requires a valid project_id (FK enforced)', () => {
    const db = setup();
    expect(() =>
      createTask(db, { project_id: 'nope', title: 'x' }),
    ).toThrow();
  });

  it('createTask applies defaults', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'san', title: 'Write op-ed' });
    expect(t.priority).toBe('LOW');
    expect(t.status).toBe('NEW');
    expect(t.duration_minutes).toBe(30);
    expect(t.time_spent_minutes).toBe(0);
    expect(t.project_id).toBe('san');
    expect(t.title).toBe('Write op-ed');
  });

  it('updateTask supports partial updates', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'san', title: 'X' });
    const updated = updateTask(db, t.id, {
      title: 'Y',
      duration_minutes: 60,
      priority: 'HIGH',
    });
    expect(updated.title).toBe('Y');
    expect(updated.duration_minutes).toBe(60);
    expect(updated.priority).toBe('HIGH');
    expect(updated.project_id).toBe('san');
  });

  it('allows legal status transitions', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'san', title: 'X' });
    setTaskStatus(db, t.id, 'SCHEDULED');
    setTaskStatus(db, t.id, 'IN_PROGRESS');
    const done = setTaskStatus(db, t.id, 'COMPLETE');
    expect(done.status).toBe('COMPLETE');
  });

  it('rejects illegal status transitions (COMPLETE -> IN_PROGRESS)', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'san', title: 'X' });
    setTaskStatus(db, t.id, 'COMPLETE');
    expect(() => setTaskStatus(db, t.id, 'IN_PROGRESS')).toThrow();
  });

  it('listTasks filters by project, status, due_before', () => {
    const db = setup();
    createTask(db, { project_id: 'san', title: 'A' });
    createTask(db, { project_id: 'san', title: 'B', due: '2026-05-01T00:00:00Z' });
    createTask(db, { project_id: 'mtb', title: 'C' });

    expect(listTasks(db, { project_id: 'san' }).length).toBe(2);
    expect(listTasks(db, { project_id: 'mtb' }).length).toBe(1);
    expect(listTasks(db, { status: 'NEW' }).length).toBe(3);
    expect(
      listTasks(db, { due_before: '2026-06-01T00:00:00Z' }).length,
    ).toBe(1);
  });

  it('searchTasks matches title and notes (case-insensitive LIKE)', () => {
    const db = setup();
    createTask(db, { project_id: 'san', title: 'Newsletter draft', notes: null });
    createTask(db, {
      project_id: 'san',
      title: 'Bike tune',
      notes: 'replace cassette',
    });

    expect(searchTasks(db, 'newsletter').length).toBe(1);
    expect(searchTasks(db, 'cassette').length).toBe(1);
    expect(searchTasks(db, 'NEWSLETTER').length).toBe(1);
    expect(searchTasks(db, 'nothing').length).toBe(0);
  });

  it('deleteTask soft-archives by default', () => {
    const db = setup();
    const t = createTask(db, { project_id: 'san', title: 'X' });
    deleteTask(db, t.id);
    const after = getTask(db, t.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('ARCHIVED');
  });
});
