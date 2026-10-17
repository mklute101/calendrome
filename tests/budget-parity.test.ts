import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import type { DB } from '../src/db/connection.js';
import { createProject } from '../src/projects.js';
import { createGoal } from '../src/goals.js';
import { createHabit, generateHabitInstances, completeHabitInstance } from '../src/habits.js';
import { insertTimeEntry } from '../src/time-entry.js';
import { getProjectBudget, getAllBudgets } from '../src/budgets.js';
import { assignHours, getEnvelopes, pullHours } from '../src/assignments.js';
import { buildTools } from '../src/mcp/tools/index.js';

const WEEK = '2026-07-13'; // Monday, UTC categories on a fresh DB

function entry(
  db: DB,
  start: string,
  minutes: number,
  extra: { project_id: string; goal_id?: number },
) {
  return insertTimeEntry(db, {
    ...extra,
    start_at: start,
    end_at: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
    status: 'CONFIRMED',
    source: 'manual',
  });
}

function projectEnvelope(db: DB, id: string, week = WEEK) {
  return getEnvelopes(db, week).find((e) => e.envelope_type === 'project' && e.envelope_id === id)!;
}

describe('budgets and envelopes agree on activity (#173 review)', () => {
  // A pull from a project into one of its own goals must not count the
  // goal block twice (goal activity + project activity on the reduced cap).
  it('20h cap, 2h pulled to its goal, 2h goal block, 17h task work: 17h of 18h in both reads', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme', prefix: 'ACME', weekly_budget_minutes: 1200 });
    const goal = createGoal(db, {
      project_id: 'acme',
      title: 'Prospecting',
      target_minutes: 600,
      due: '2026-08-10',
    });
    pullHours(db, {
      week_start: WEEK,
      from: { type: 'project', id: 'acme' },
      to: { type: 'goal', id: String(goal.id) },
      minutes: 120,
    });
    entry(db, '2026-07-14T09:00:00Z', 120, { project_id: 'acme', goal_id: goal.id });
    // 17h of task work: Mon-Thu 4h + Fri 1h.
    for (const [day, mins] of [['13', 240], ['14', 240], ['15', 240], ['16', 240], ['17', 60]] as const) {
      entry(db, `2026-07-${day}T13:00:00Z`, mins, { project_id: 'acme' });
    }

    const budget = getProjectBudget(db, 'acme', WEEK);
    expect(budget.assigned_minutes).toBe(1080);
    expect(budget.confirmed_minutes).toBe(1020);
    expect(budget.available_minutes).toBe(60);
    expect(budget.overspent).toBe(false);

    const env = projectEnvelope(db, 'acme');
    expect(env.assigned).toBe(1080);
    expect(env.activity.confirmed_minutes).toBe(1020);
    expect(env.available).toBe(60);
    expect(env.funding).toBe('on_track');
  });

  it('habit entries credit the habit envelope, not the project budget', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme', prefix: 'ACME', weekly_budget_minutes: 60 });
    const h = createHabit(db, {
      project_id: 'acme',
      title: 'Standup',
      duration_minutes: 30,
      days_of_week: '1',
      start_time: '09:00',
      timezone: 'UTC',
    });
    const [inst] = generateHabitInstances(db, h.id, '2026-07-13', '2026-07-13');
    completeHabitInstance(db, inst.id);
    expect(getProjectBudget(db, 'acme', WEEK).confirmed_minutes).toBe(0);
    expect(projectEnvelope(db, 'acme').activity.confirmed_minutes).toBe(0);
  });
});

describe('one resolution: budgets, envelopes and pulls agree on every assignment state (#173 review)', () => {
  type Case = {
    name: string;
    standing: number | null;
    week?: number | null; // undefined = no explicit row
    assigned: number | null;
    snoozed: boolean;
    pullable: number;
    funding: 'snoozed' | 'on_track' | 'overspent';
  };
  // Activity in every case: 30 confirmed minutes.
  const cases: Case[] = [
    { name: 'explicit row', standing: 600, week: 300, assigned: 300, snoozed: false, pullable: 300, funding: 'on_track' },
    { name: 'explicit snooze', standing: 600, week: null, assigned: null, snoozed: true, pullable: 0, funding: 'snoozed' },
    { name: 'explicit 0', standing: 600, week: 0, assigned: 0, snoozed: false, pullable: 0, funding: 'overspent' },
    { name: 'standing only', standing: 600, assigned: 600, snoozed: false, pullable: 600, funding: 'on_track' },
    { name: 'standing 0', standing: 0, assigned: 0, snoozed: false, pullable: 0, funding: 'overspent' },
    { name: 'uncapped', standing: null, assigned: null, snoozed: false, pullable: 0, funding: 'on_track' },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const db = freshDb();
      createProject(db, { id: 'acme', name: 'Acme', prefix: 'ACME', weekly_budget_minutes: c.standing });
      createProject(db, { id: 'sink', name: 'Sink', prefix: 'SINK' });
      if (c.week !== undefined) {
        assignHours(db, { envelope_type: 'project', envelope_id: 'acme', week_start: WEEK, minutes: c.week });
      }
      entry(db, '2026-07-14T10:00:00Z', 30, { project_id: 'acme' });

      // Budgets (core + both MCP tools)
      const budget = getProjectBudget(db, 'acme', WEEK);
      expect(budget.assigned_minutes).toBe(c.assigned);
      expect(budget.snoozed).toBe(c.snoozed);
      expect(budget.overspent).toBe(c.funding === 'overspent');
      expect(getAllBudgets(db, WEEK).find((b) => b.project_id === 'acme')).toEqual(budget);
      const tools = buildTools(db);
      const call = (n: string, a: object) => tools.find((t) => t.name === n)!.handler(a);
      expect((await call('get_project_budget', { project_id: 'acme', week_start: WEEK })).budget).toEqual(budget);

      // Envelopes
      const env = projectEnvelope(db, 'acme');
      expect(env.assigned).toBe(c.assigned);
      expect(env.funding).toBe(c.funding);
      expect(env.funding === 'snoozed').toBe(c.snoozed);
      if (budget.available_minutes !== null) expect(env.available).toBe(budget.available_minutes);

      // Pulls: exactly `pullable` minutes can leave the envelope.
      expect(() =>
        pullHours(db, { week_start: WEEK, from: { type: 'project', id: 'acme' }, to: { type: 'project', id: 'sink' }, minutes: c.pullable + 1 }),
      ).toThrow(new RegExp(`only ${c.pullable}m assigned`));
      if (c.pullable > 0) {
        pullHours(db, { week_start: WEEK, from: { type: 'project', id: 'acme' }, to: { type: 'project', id: 'sink' }, minutes: c.pullable });
        expect(getProjectBudget(db, 'acme', WEEK).assigned_minutes).toBe(0);
      }
    });
  }
});

describe('budget reads require a Monday, like get_envelopes (#173 review)', () => {
  it('rejects a non-Monday week_start in core and over MCP', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme', prefix: 'ACME', weekly_budget_minutes: 600 });
    expect(() => getProjectBudget(db, 'acme', '2026-07-14')).toThrow(/Monday/);
    expect(() => getAllBudgets(db, '2026-07-14')).toThrow(/Monday/);
    expect(() => getEnvelopes(db, '2026-07-14')).toThrow(/Monday/);
    const tool = buildTools(db).find((t) => t.name === 'get_all_budgets')!;
    await expect(tool.handler({ week_start: '2026-07-14' })).rejects.toThrow(/Monday/);
  });
});
