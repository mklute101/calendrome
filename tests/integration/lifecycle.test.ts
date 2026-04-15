import { describe, it, expect } from 'vitest';
import { freshDb } from '../helpers/db.js';
import { createProject } from '../../src/projects.js';
import { createTask } from '../../src/tasks.js';
import { startTask, stopTask, completeTask } from '../../src/time-log.js';
import {
  createHabit,
  generateHabitInstances,
  completeHabitInstance,
  skipHabitInstance,
} from '../../src/habits.js';
import { getProjectBudget } from '../../src/budgets.js';
import { exportTimesheet } from '../../src/timesheet.js';

/**
 * End-to-end integration: create a project, do work, export, check budgets.
 * Time logs are inserted directly with explicit durations to keep the test
 * deterministic without 5-minute sleeps.
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
  db.prepare(
    `UPDATE tasks SET time_spent_minutes = time_spent_minutes + ? WHERE id = ?`,
  ).run(durationMinutes, taskId);
}

describe('integration: full lifecycle', () => {
  const WEEK_START = '2026-04-13';

  it('project + tasks + time log + budget + CSV export work together', () => {
    const db = freshDb();
    createProject(db, {
      id: 'san',
      name: 'SAN',
      prefix: 'SAN',
      weekly_budget_minutes: 300, // 5h
    });

    const a = createTask(db, { project_id: 'san', title: 'Op-ed' });
    const b = createTask(db, { project_id: 'san', title: 'Newsletter' });
    createTask(db, { project_id: 'san', title: 'Pitch deck' });

    insertTimeLog(db, a.id, '2026-04-14T09:00:00Z', 90); // 1.5h
    insertTimeLog(db, b.id, '2026-04-15T11:00:00Z', 30); // 0.5h

    const budget = getProjectBudget(db, 'san', WEEK_START);
    expect(budget.allocated_minutes).toBe(300);
    expect(budget.spent_minutes).toBe(120);
    expect(budget.remaining_minutes).toBe(180);
    expect(budget.over_budget).toBe(false);

    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('date,project,hours,task,notes');
    expect(lines).toContain('2026-04-14,SAN,1.5,Op-ed,');
    expect(lines).toContain('2026-04-15,SAN,0.5,Newsletter,');
  });

  it('habit lifecycle: create, generate, complete, skip, budget reflects scheduled time', () => {
    const db = freshDb();
    createProject(db, {
      id: 'me',
      name: 'Me',
      prefix: 'ME',
      weekly_budget_minutes: 60, // 1h
    });

    const h = createHabit(db, {
      project_id: 'me',
      title: 'Standup',
      duration_minutes: 30,
      days_of_week: '1,2,3,4,5', // Mon-Fri
      start_time: '09:00',
      timezone: 'UTC',
    });

    const instances = generateHabitInstances(
      db,
      h.id,
      '2026-04-13',
      '2026-04-19',
    );
    expect(instances.length).toBe(5);

    completeHabitInstance(db, instances[0].id);
    completeHabitInstance(db, instances[1].id);
    skipHabitInstance(db, instances[2].id);

    const budget = getProjectBudget(db, 'me', WEEK_START);
    // All 5 instances live in the week, even after completion/skipping
    expect(budget.scheduled_minutes).toBeGreaterThanOrEqual(60);
    expect(budget.over_budget).toBe(true);
  });

  it('using the real task lifecycle helpers end-to-end', async () => {
    const db = freshDb();
    createProject(db, { id: 'san', name: 'SAN', prefix: 'SAN' });
    const t = createTask(db, { project_id: 'san', title: 'X' });

    startTask(db, t.id);
    await new Promise((r) => setTimeout(r, 1100));
    stopTask(db, t.id);

    const done = completeTask(db, t.id);
    expect(done.status).toBe('COMPLETE');
  });
});
