import { describe, it, expect } from 'vitest';
import { freshDb } from '../helpers/db.js';
import { createProject } from '../../src/projects.js';
import { createTask } from '../../src/tasks.js';
import { completeTask } from '../../src/time-log.js';
import {
  createHabit,
  generateHabitInstances,
  completeHabitInstance,
  skipHabitInstance,
} from '../../src/habits.js';
import { getProjectBudget } from '../../src/budgets.js';
import { exportTimesheet } from '../../src/timesheet.js';
import { insertTimeEntry } from '../../src/time-entry.js';

/**
 * End-to-end integration: create a project, do work, export, check budgets.
 * Time logs are inserted directly with explicit durations to keep the test
 * deterministic without 5-minute sleeps. We seed both `time_log` (legacy
 * surface) and a CONFIRMED `time_entry` (the export and budget queries
 * now read from there via `v_task_time_spent`).
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

  const start = new Date(startedAt);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const task = db
    .prepare('SELECT project_id FROM tasks WHERE id = ?')
    .get(taskId) as { project_id: string };
  insertTimeEntry(db, {
    task_id: taskId,
    project_id: task.project_id,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    actual_minutes: durationMinutes,
    status: 'CONFIRMED',
    confirmed_at: end.toISOString(),
    source: 'manual',
  });
}

describe('integration: full lifecycle', () => {
  const WEEK_START = '2026-04-13';

  it('project + tasks + time log + budget + CSV export work together', () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      weekly_budget_minutes: 300, // 5h
    });

    const a = createTask(db, { project_id: 'acme', title: 'Report' });
    const b = createTask(db, { project_id: 'acme', title: 'Memo' });
    createTask(db, { project_id: 'acme', title: 'Pitch deck' });

    insertTimeLog(db, a.id, '2026-04-14T09:00:00Z', 90); // 1.5h
    insertTimeLog(db, b.id, '2026-04-15T11:00:00Z', 30); // 0.5h

    const budget = getProjectBudget(db, 'acme', WEEK_START);
    expect(budget.allocated_minutes).toBe(300);
    expect(budget.spent_minutes).toBe(120);
    expect(budget.remaining_minutes).toBe(180);
    expect(budget.over_budget).toBe(false);

    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('date,project,hours,task,notes');
    expect(lines).toContain('2026-04-14,ACME,1.5,Report,');
    expect(lines).toContain('2026-04-15,ACME,0.5,Memo,');
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

  it('using the real task lifecycle helpers end-to-end', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const t = createTask(db, { project_id: 'acme', title: 'X' });

    const done = completeTask(db, t.id);
    expect(done.status).toBe('COMPLETE');
  });
});
