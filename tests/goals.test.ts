import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import {
  createGoal,
  getGoal,
  listGoals,
  updateGoal,
  deactivateGoal,
  goalProgress,
  assertMonday,
  currentWeekMonday,
} from '../src/goals.js';
import { insertTimeEntry } from '../src/time-entry.js';
import { logTime } from '../src/time-log.js';

// 2026-07-13 is a Monday.
const WEEK = '2026-07-13';

function setup() {
  const db = freshDb();
  createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
  createProject(db, { id: 'personal', name: 'Personal', prefix: 'PERS' });
  return db;
}

describe('goals: create/list/update/deactivate', () => {
  it('creates a refill goal', () => {
    const db = setup();
    const g = createGoal(db, {
      project_id: 'personal',
      title: 'Spanish practice',
      target_minutes: 180,
      refill_period: 'week',
    });
    expect(g.id).toBeGreaterThan(0);
    expect(g.refill_period).toBe('week');
    expect(g.due).toBeNull();
    expect(g.active).toBe(1);
  });

  it('creates a by-date goal with min_chunk_minutes', () => {
    const db = setup();
    const g = createGoal(db, {
      project_id: 'acme',
      title: 'Prospecting before launch',
      target_minutes: 600,
      due: '2026-08-10',
      min_chunk_minutes: 120,
    });
    expect(g.due).toBe('2026-08-10');
    expect(g.refill_period).toBeNull();
    expect(g.min_chunk_minutes).toBe(120);
  });

  it('rejects both or neither of due/refill_period', () => {
    const db = setup();
    expect(() =>
      createGoal(db, {
        project_id: 'acme',
        title: 'X',
        target_minutes: 60,
        due: '2026-08-10',
        refill_period: 'week',
      }),
    ).toThrow(/exactly one/);
    expect(() =>
      createGoal(db, { project_id: 'acme', title: 'X', target_minutes: 60 }),
    ).toThrow(/exactly one/);
  });

  it('rejects non-positive target, bad refill period, unknown project', () => {
    const db = setup();
    expect(() =>
      createGoal(db, {
        project_id: 'acme',
        title: 'X',
        target_minutes: 0,
        refill_period: 'week',
      }),
    ).toThrow(/target_minutes/);
    expect(() =>
      createGoal(db, {
        project_id: 'acme',
        title: 'X',
        target_minutes: 60,
        refill_period: 'month',
      }),
    ).toThrow(/refill_period/);
    expect(() =>
      createGoal(db, {
        project_id: 'nope',
        title: 'X',
        target_minutes: 60,
        refill_period: 'week',
      }),
    ).toThrow(/not found/);
  });

  it('lists with active filter; deactivate soft-deletes', () => {
    const db = setup();
    const a = createGoal(db, {
      project_id: 'acme',
      title: 'A',
      target_minutes: 60,
      refill_period: 'week',
    });
    createGoal(db, {
      project_id: 'acme',
      title: 'B',
      target_minutes: 60,
      refill_period: 'week',
    });
    deactivateGoal(db, a.id);
    expect(listGoals(db).length).toBe(2);
    const active = listGoals(db, { active: true });
    expect(active.length).toBe(1);
    expect(active[0].title).toBe('B');
    expect(getGoal(db, a.id)?.active).toBe(0);
  });

  it('updateGoal patches fields but preserves exactly-one-of flavor', () => {
    const db = setup();
    const g = createGoal(db, {
      project_id: 'acme',
      title: 'A',
      target_minutes: 60,
      refill_period: 'week',
    });
    const updated = updateGoal(db, g.id, { target_minutes: 120 });
    expect(updated.target_minutes).toBe(120);

    // Setting due without clearing refill_period → both set → rejected.
    expect(() => updateGoal(db, g.id, { due: '2026-08-10' })).toThrow(/exactly one/);
    // Explicitly flipping flavor works.
    const flipped = updateGoal(db, g.id, { due: '2026-08-10', refill_period: null });
    expect(flipped.due).toBe('2026-08-10');
    expect(flipped.refill_period).toBeNull();
  });
});

describe('goals: goalProgress', () => {
  it('refill: ask is the target; needed shrinks with confirmed + scheduled', () => {
    const db = setup();
    const g = createGoal(db, {
      project_id: 'personal',
      title: 'Spanish',
      target_minutes: 180,
      refill_period: 'week',
    });
    // 120 confirmed + 30 scheduled inside the week.
    insertTimeEntry(db, {
      project_id: 'personal',
      goal_id: g.id,
      start_at: '2026-07-14T18:00:00Z',
      end_at: '2026-07-14T20:00:00Z',
      status: 'CONFIRMED',
      source: 'manual',
    });
    insertTimeEntry(db, {
      project_id: 'personal',
      goal_id: g.id,
      start_at: '2026-07-16T18:00:00Z',
      end_at: '2026-07-16T18:30:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });
    const p = goalProgress(db, g.id, WEEK);
    expect(p.flavor).toBe('refill');
    expect(p.weekly_ask).toBe(180);
    expect(p.week_confirmed).toBe(120);
    expect(p.week_scheduled).toBe(30);
    expect(p.needed_this_week).toBe(30);
    expect(p.status).toBe('on_track');
    expect(p.remaining_minutes).toBeNull();
    expect(p.weeks_left).toBeNull();
  });

  it('refill: funded when scheduled covers the ask, complete when confirmed does', () => {
    const db = setup();
    const g = createGoal(db, {
      project_id: 'personal',
      title: 'Spanish',
      target_minutes: 60,
      refill_period: 'week',
    });
    const scheduledId = insertTimeEntry(db, {
      project_id: 'personal',
      goal_id: g.id,
      start_at: '2026-07-15T18:00:00Z',
      end_at: '2026-07-15T19:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });
    expect(goalProgress(db, g.id, WEEK).status).toBe('funded');
    db.prepare("UPDATE time_entry SET status = 'CONFIRMED' WHERE id = ?").run(
      scheduledId,
    );
    expect(goalProgress(db, g.id, WEEK).status).toBe('complete');
  });

  it('by-date: re-paces as remaining ÷ weeks left, honoring actual_minutes', () => {
    const db = setup();
    const g = createGoal(db, {
      project_id: 'acme',
      title: 'Prospecting',
      target_minutes: 600,
      due: '2026-08-10', // 4 weeks after WEEK
    });
    let p = goalProgress(db, g.id, WEEK);
    expect(p.flavor).toBe('by_date');
    expect(p.weeks_left).toBe(4);
    expect(p.remaining_minutes).toBe(600);
    expect(p.weekly_ask).toBe(150);

    // Span says 60 min but actual_minutes overrides to 300.
    insertTimeEntry(db, {
      project_id: 'acme',
      goal_id: g.id,
      start_at: '2026-07-06T10:00:00Z', // previous week: all-time still counts
      end_at: '2026-07-06T11:00:00Z',
      actual_minutes: 300,
      status: 'CONFIRMED',
      source: 'manual',
    });
    p = goalProgress(db, g.id, WEEK);
    expect(p.confirmed_minutes).toBe(300);
    expect(p.remaining_minutes).toBe(300);
    expect(p.weekly_ask).toBe(75);
    expect(p.status).toBe('on_track');
  });

  it('by-date: behind after the due date, complete when the bucket fills', () => {
    const db = setup();
    const g = createGoal(db, {
      project_id: 'acme',
      title: 'Prospecting',
      target_minutes: 120,
      due: '2026-07-06',
    });
    // Week starts after the due date, bucket unfilled → behind.
    expect(goalProgress(db, g.id, WEEK).status).toBe('behind');
    insertTimeEntry(db, {
      project_id: 'acme',
      goal_id: g.id,
      start_at: '2026-07-01T10:00:00Z',
      end_at: '2026-07-01T12:00:00Z',
      status: 'CONFIRMED',
      source: 'manual',
    });
    expect(goalProgress(db, g.id, WEEK).status).toBe('complete');
  });

  it('rejects a non-Monday week_start', () => {
    const db = setup();
    const g = createGoal(db, {
      project_id: 'acme',
      title: 'X',
      target_minutes: 60,
      refill_period: 'week',
    });
    expect(() => goalProgress(db, g.id, '2026-07-14')).toThrow(/Monday/);
  });
});

describe('goals: time flows in via log_time', () => {
  it('logTime accepts goal_id and derives the project from the goal', () => {
    const db = setup();
    const g = createGoal(db, {
      project_id: 'personal',
      title: 'Spanish',
      target_minutes: 180,
      refill_period: 'week',
    });
    const entry = logTime(db, {
      goal_id: g.id,
      started_at: '2026-07-14T18:00:00Z',
      stopped_at: '2026-07-14T19:00:00Z',
    });
    expect(entry.goal_id).toBe(g.id);
    expect(entry.project_id).toBe('personal');
    expect(goalProgress(db, g.id, WEEK).week_confirmed).toBe(60);
  });

  it('logTime rejects an unknown goal', () => {
    const db = setup();
    expect(() =>
      logTime(db, {
        goal_id: 999,
        started_at: '2026-07-14T18:00:00Z',
        stopped_at: '2026-07-14T19:00:00Z',
      }),
    ).toThrow(/goal 999 not found/);
  });
});

describe('goals: week helpers', () => {
  it('assertMonday accepts Mondays and rejects everything else', () => {
    expect(() => assertMonday('2026-07-13')).not.toThrow();
    expect(() => assertMonday('2026-07-18')).toThrow(/Monday/);
    expect(() => assertMonday('2026-07-13T00:00:00Z')).toThrow(/plain ISO date/);
  });

  it('currentWeekMonday lands on a Monday containing the date', () => {
    expect(currentWeekMonday(new Date('2026-07-18T12:00:00Z'))).toBe('2026-07-13');
    expect(currentWeekMonday(new Date('2026-07-13T00:00:00Z'))).toBe('2026-07-13');
    expect(currentWeekMonday(new Date('2026-07-19T23:00:00Z'))).toBe('2026-07-13'); // Sunday
  });
});
