import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createTask, updateTask } from '../src/tasks.js';
import { createHabit, generateHabitInstances } from '../src/habits.js';
import { getProjectBudget, getAllBudgets } from '../src/budgets.js';

/**
 * Inserts a closed time_log row directly so we can pin exact durations
 * without sleeping in tests.
 */
function insertTimeLog(
  db: any,
  taskId: number,
  startedAt: string,
  durationMinutes: number,
) {
  db.prepare(
    `INSERT INTO time_log (task_id, started_at, stopped_at, duration_minutes)
     VALUES (?, ?, ?, ?)`,
  ).run(taskId, startedAt, startedAt, durationMinutes);

  // Keep tasks.time_spent_minutes in sync so the budget queries that join
  // through tasks see consistent values.
  db.prepare(
    `UPDATE tasks SET time_spent_minutes = time_spent_minutes + ? WHERE id = ?`,
  ).run(durationMinutes, taskId);
}

describe('budgets', () => {
  // Mon 2026-04-13 -> Sun 2026-04-19
  const WEEK_START = '2026-04-13';

  it('returns allocated/spent/scheduled/remaining/over_budget per project', () => {
    const db = freshDb();
    createProject(db, {
      id: 'san',
      name: 'SAN',
      prefix: 'SAN',
      weekly_budget_minutes: 600, // 10 hours
    });

    const t = createTask(db, { project_id: 'san', title: 'X' });
    insertTimeLog(db, t.id, '2026-04-14T10:00:00Z', 120); // 2h spent in week

    const budget = getProjectBudget(db, 'san', WEEK_START);
    expect(budget.allocated_minutes).toBe(600);
    expect(budget.spent_minutes).toBe(120);
    expect(budget.scheduled_minutes).toBe(0);
    expect(budget.remaining_minutes).toBe(480);
    expect(budget.over_budget).toBe(false);
  });

  it('counts habit instances within the week as scheduled time', () => {
    const db = freshDb();
    createProject(db, {
      id: 'me',
      name: 'Me',
      prefix: 'ME',
      weekly_budget_minutes: 60,
    });
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Standup',
      duration_minutes: 30,
      days_of_week: '1,2,3,4,5',
      start_time: '09:00',
      timezone: 'UTC',
    });
    generateHabitInstances(db, h.id, '2026-04-13', '2026-04-19');

    const budget = getProjectBudget(db, 'me', WEEK_START);
    expect(budget.scheduled_minutes).toBe(30 * 5); // 150 min
    expect(budget.over_budget).toBe(true);
    expect(budget.remaining_minutes).toBe(60 - 150);
  });

  it('counts placed tasks (with calendar_event_id) as scheduled time', () => {
    const db = freshDb();
    createProject(db, {
      id: 'san',
      name: 'SAN',
      prefix: 'SAN',
      weekly_budget_minutes: 600,
    });
    const t = createTask(db, {
      project_id: 'san',
      title: 'X',
      duration_minutes: 90,
    });
    updateTask(db, t.id, {
      calendar_event_id: 'evt-1',
      due: '2026-04-15T14:00:00Z',
    });

    const budget = getProjectBudget(db, 'san', WEEK_START);
    expect(budget.scheduled_minutes).toBe(90);
  });

  it('over_budget=true when spent + scheduled exceeds allocation', () => {
    const db = freshDb();
    createProject(db, {
      id: 'san',
      name: 'SAN',
      prefix: 'SAN',
      weekly_budget_minutes: 60,
    });
    const t = createTask(db, { project_id: 'san', title: 'X' });
    insertTimeLog(db, t.id, '2026-04-14T10:00:00Z', 90);

    const budget = getProjectBudget(db, 'san', WEEK_START);
    expect(budget.over_budget).toBe(true);
  });

  it('null budget never warns', () => {
    const db = freshDb();
    createProject(db, { id: 'p', name: 'P', prefix: 'P' });
    const t = createTask(db, { project_id: 'p', title: 'X' });
    insertTimeLog(db, t.id, '2026-04-14T10:00:00Z', 9999);

    const budget = getProjectBudget(db, 'p', WEEK_START);
    expect(budget.allocated_minutes).toBeNull();
    expect(budget.over_budget).toBe(false);
    expect(budget.remaining_minutes).toBeNull();
  });

  it('getAllBudgets returns one row per active project', () => {
    const db = freshDb();
    createProject(db, {
      id: 'a',
      name: 'A',
      prefix: 'A',
      weekly_budget_minutes: 60,
    });
    createProject(db, {
      id: 'b',
      name: 'B',
      prefix: 'B',
      weekly_budget_minutes: 60,
    });
    createProject(db, { id: 'c', name: 'C', prefix: 'C' });
    // Deactivate c
    db.prepare('UPDATE projects SET active = 0 WHERE id = ?').run('c');

    const all = getAllBudgets(db, WEEK_START);
    const ids = all.map((b) => b.project_id).sort();
    expect(ids).toEqual(['a', 'b']);
  });
});
