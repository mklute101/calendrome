import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createTask } from '../src/tasks.js';
import { createHabit, generateHabitInstances } from '../src/habits.js';
import { getProjectBudget, getAllBudgets } from '../src/budgets.js';
import { insertTimeEntry } from '../src/time-entry.js';

/**
 * Insert a CONFIRMED time_entry — the new source of truth for spent
 * minutes. Replaces the old direct `time_log` writes.
 */
function insertConfirmed(
  db: any,
  opts: {
    project_id: string;
    task_id?: number | null;
    started_at: string;
    duration_minutes: number;
  },
) {
  const endMs = Date.parse(opts.started_at) + opts.duration_minutes * 60_000;
  insertTimeEntry(db, {
    task_id: opts.task_id ?? null,
    project_id: opts.project_id,
    start_at: opts.started_at,
    end_at: new Date(endMs).toISOString(),
    actual_minutes: opts.duration_minutes,
    status: 'CONFIRMED',
    confirmed_at: opts.started_at,
    source: 'manual',
  });
}

/**
 * Insert an UNCONFIRMED placement time_entry — the new representation
 * of "scheduled but not yet done" work, replacing the old pattern of
 * setting `task.calendar_event_id` and reading `tasks.duration_minutes`.
 */
function insertScheduled(
  db: any,
  opts: {
    project_id: string;
    task_id?: number | null;
    started_at: string;
    duration_minutes: number;
  },
) {
  const endMs = Date.parse(opts.started_at) + opts.duration_minutes * 60_000;
  insertTimeEntry(db, {
    task_id: opts.task_id ?? null,
    project_id: opts.project_id,
    start_at: opts.started_at,
    end_at: new Date(endMs).toISOString(),
    actual_minutes: opts.duration_minutes,
    status: 'UNCONFIRMED',
    source: 'placement',
  });
}

describe('budgets', () => {
  // Mon 2026-04-13 -> Sun 2026-04-19
  const WEEK_START = '2026-04-13';

  it('returns assigned/confirmed/scheduled/available/overspent per project', () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      weekly_budget_minutes: 600, // 10 hours
    });

    const t = createTask(db, { project_id: 'acme', title: 'X' });
    insertConfirmed(db, {
      project_id: 'acme',
      task_id: t.id,
      started_at: '2026-04-14T10:00:00Z',
      duration_minutes: 120,
    }); // 2h confirmed in week

    const budget = getProjectBudget(db, 'acme', WEEK_START);
    expect(budget.assigned_minutes).toBe(600);
    expect(budget.confirmed_minutes).toBe(120);
    expect(budget.scheduled_minutes).toBe(0);
    expect(budget.available_minutes).toBe(480);
    expect(budget.overspent).toBe(false);
  });

  it('UNCONFIRMED rows count as scheduled, not confirmed', () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      weekly_budget_minutes: 600,
    });
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    insertScheduled(db, {
      project_id: 'acme',
      task_id: t.id,
      started_at: '2026-04-15T14:00:00Z',
      duration_minutes: 90,
    });

    const budget = getProjectBudget(db, 'acme', WEEK_START);
    expect(budget.confirmed_minutes).toBe(0);
    expect(budget.scheduled_minutes).toBe(90);
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
    // generateHabitInstances also writes paired UNCONFIRMED time_entry
    // rows (source='habit'), which is what budgets now reads.
    generateHabitInstances(db, h.id, '2026-04-13', '2026-04-19');

    const budget = getProjectBudget(db, 'me', WEEK_START);
    expect(budget.scheduled_minutes).toBe(30 * 5); // 150 min
    expect(budget.overspent).toBe(true);
    expect(budget.available_minutes).toBe(60 - 150);
  });

  it('counts placement-style UNCONFIRMED time_entry rows as scheduled time', () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      weekly_budget_minutes: 600,
    });
    const t = createTask(db, {
      project_id: 'acme',
      title: 'X',
      duration_minutes: 90,
    });
    insertScheduled(db, {
      project_id: 'acme',
      task_id: t.id,
      started_at: '2026-04-15T14:00:00Z',
      duration_minutes: 90,
    });

    const budget = getProjectBudget(db, 'acme', WEEK_START);
    expect(budget.scheduled_minutes).toBe(90);
  });

  it('counts meeting time_entry rows (is_meeting=1) toward the project rollup', () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      weekly_budget_minutes: 600,
    });
    // gcal-synced confirmed meeting — counts as confirmed activity, like any other
    // CONFIRMED time_entry on the project.
    insertTimeEntry(db, {
      project_id: 'acme',
      start_at: '2026-04-14T15:00:00Z',
      end_at: '2026-04-14T16:00:00Z',
      actual_minutes: 60,
      status: 'CONFIRMED',
      confirmed_at: '2026-04-14T15:00:00Z',
      source: 'gcal-sync',
      external_id: 'gcal-1',
      is_meeting: true,
    });

    const budget = getProjectBudget(db, 'acme', WEEK_START);
    expect(budget.confirmed_minutes).toBe(60);
  });

  it('ignores time_entry rows outside the week range', () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      weekly_budget_minutes: 600,
    });
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    // Previous week
    insertConfirmed(db, {
      project_id: 'acme',
      task_id: t.id,
      started_at: '2026-04-07T10:00:00Z',
      duration_minutes: 300,
    });
    // Following week
    insertConfirmed(db, {
      project_id: 'acme',
      task_id: t.id,
      started_at: '2026-04-20T10:00:00Z',
      duration_minutes: 300,
    });
    // In-week
    insertConfirmed(db, {
      project_id: 'acme',
      task_id: t.id,
      started_at: '2026-04-14T10:00:00Z',
      duration_minutes: 45,
    });

    const budget = getProjectBudget(db, 'acme', WEEK_START);
    expect(budget.confirmed_minutes).toBe(45);
  });

  it('overspent=true when confirmed + scheduled exceeds the assignment', () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      weekly_budget_minutes: 60,
    });
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    insertConfirmed(db, {
      project_id: 'acme',
      task_id: t.id,
      started_at: '2026-04-14T10:00:00Z',
      duration_minutes: 90,
    });

    const budget = getProjectBudget(db, 'acme', WEEK_START);
    expect(budget.overspent).toBe(true);
  });

  it('null assignment never warns', () => {
    const db = freshDb();
    createProject(db, { id: 'p', name: 'P', prefix: 'P' });
    const t = createTask(db, { project_id: 'p', title: 'X' });
    insertConfirmed(db, {
      project_id: 'p',
      task_id: t.id,
      started_at: '2026-04-14T10:00:00Z',
      duration_minutes: 9999,
    });

    const budget = getProjectBudget(db, 'p', WEEK_START);
    expect(budget.assigned_minutes).toBeNull();
    expect(budget.overspent).toBe(false);
    expect(budget.available_minutes).toBeNull();
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
