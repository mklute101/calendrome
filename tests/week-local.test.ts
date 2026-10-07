import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import type { DB } from '../src/db/connection.js';
import { updateCategory } from '../src/categories.js';
import { createProject } from '../src/projects.js';
import { createGoal, goalProgress } from '../src/goals.js';
import { createHabit } from '../src/habits.js';
import { insertTimeEntry } from '../src/time-entry.js';
import { budgetWeekRange, getProjectBudget } from '../src/budgets.js';
import { envelopeWeekRange, getEnvelopes } from '../src/assignments.js';
import { computeWeekSupply, supplyWeekRange } from '../src/supply.js';
import { currentWeekMonday, weekRange } from '../src/day-range.js';
import { buildTools } from '../src/mcp/tools/index.js';

/**
 * Weekly accounting follows the category timezone (#146). Each
 * numbered block below is one acceptance criterion from the issue's
 * spec; the UTC regression gate (acceptance 5) is the rest of the
 * suite running unchanged.
 *
 * Instants used, all in July 2026 (CDT = UTC-5, CEST = UTC+2):
 *   Thu 2026-07-23 19:00 CDT = 2026-07-24T00:00:00Z
 *   Sun 2026-07-26 19:00 CDT = 2026-07-27T00:00:00Z  (Monday in UTC)
 *   Sun 2026-07-26 23:30 CDT = 2026-07-27T04:30:00Z
 *   Mon 2026-07-27 00:30 CDT = 2026-07-27T05:30:00Z
 *   Sun 2026-07-26 23:30 CEST = 2026-07-26T21:30:00Z
 *   Mon 2026-07-27 00:30 CEST = 2026-07-26T22:30:00Z (still Sunday in UTC)
 */

const WEEK2 = '2026-07-20';
const WEEK3 = '2026-07-27';
const HOUR = 3_600_000;

function confirmed(
  db: DB,
  project_id: string,
  start_at: string,
  minutes: number,
  extra: { goal_id?: number } = {},
): void {
  const end_at = new Date(Date.parse(start_at) + minutes * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  insertTimeEntry(db, {
    project_id,
    goal_id: extra.goal_id ?? null,
    start_at,
    end_at,
    actual_minutes: minutes,
    status: 'CONFIRMED',
    confirmed_at: end_at,
    source: 'manual',
  });
}

function setupChicago(): DB {
  const db = freshDb();
  updateCategory(db, 'personal', { timezone: 'America/Chicago' });
  createProject(db, {
    id: 'spanish',
    name: 'Spanish',
    prefix: 'SPAN',
    category_id: 'personal',
    weekly_budget_minutes: 300,
  });
  return db;
}

function hoursBetween(range: { startIso: string; endIso: string }): number {
  return (Date.parse(range.endIso) - Date.parse(range.startIso)) / HOUR;
}

describe('weekRange / currentWeekMonday helper', () => {
  it('UTC is the former T00:00:00Z arithmetic, exclusive end', () => {
    expect(weekRange(WEEK2)).toEqual({
      startIso: '2026-07-20T00:00:00Z',
      endIso: '2026-07-27T00:00:00Z',
    });
    expect(weekRange(WEEK2, 'UTC')).toEqual(weekRange(WEEK2));
  });

  it('resolves local Monday 00:00 west and east of UTC', () => {
    expect(weekRange(WEEK2, 'America/Chicago')).toEqual({
      startIso: '2026-07-20T05:00:00Z',
      endIso: '2026-07-27T05:00:00Z',
    });
    expect(weekRange(WEEK2, 'Europe/Berlin')).toEqual({
      startIso: '2026-07-19T22:00:00Z',
      endIso: '2026-07-26T22:00:00Z',
    });
  });

  it('rejects malformed week_start', () => {
    expect(() => weekRange('nope', 'UTC')).toThrow(/invalid week_start/);
    expect(() => weekRange('2026-07-20T00:00:00Z', 'UTC')).toThrow(/invalid week_start/);
  });

  it('currentWeekMonday follows the local week, defaulting to UTC', () => {
    const sundayEveningCdt = new Date('2026-07-27T00:30:00Z');
    expect(currentWeekMonday(sundayEveningCdt)).toBe(WEEK3);
    expect(currentWeekMonday(sundayEveningCdt, 'UTC')).toBe(WEEK3);
    expect(currentWeekMonday(sundayEveningCdt, 'America/Chicago')).toBe(WEEK2);
    // Monday 00:30 CEST is still Sunday in UTC.
    expect(currentWeekMonday(new Date('2026-07-26T22:30:00Z'), 'Europe/Berlin')).toBe(WEEK3);
    expect(currentWeekMonday(new Date('2026-07-26T22:30:00Z'))).toBe(WEEK2);
  });
});

describe('acceptance 1: the Sunday-evening Spanish session', () => {
  it('list_goals reports week_confirmed 120 for week 2 and 0 for week 3', async () => {
    const db = setupChicago();
    const goal = createGoal(db, {
      project_id: 'spanish',
      title: 'Spanish practice',
      target_minutes: 180,
      refill_period: 'week',
    });
    // 45 min Thursday 19:00 CDT, 75 min Sunday 19:00 CDT.
    confirmed(db, 'spanish', '2026-07-24T00:00:00Z', 45, { goal_id: goal.id });
    confirmed(db, 'spanish', '2026-07-27T00:00:00Z', 75, { goal_id: goal.id });

    expect(goalProgress(db, goal.id, WEEK2).week_confirmed).toBe(120);
    expect(goalProgress(db, goal.id, WEEK3).week_confirmed).toBe(0);

    const tool = buildTools(db).find((t) => t.name === 'list_goals');
    if (!tool) throw new Error('list_goals tool missing');
    const week2 = (await tool.handler({ week_start: WEEK2 })) as {
      goals: Array<{ id: number; progress: { week_confirmed: number } }>;
    };
    const week3 = (await tool.handler({ week_start: WEEK3 })) as {
      goals: Array<{ id: number; progress: { week_confirmed: number } }>;
    };
    expect(week2.goals.find((g) => g.id === goal.id)?.progress.week_confirmed).toBe(120);
    expect(week3.goals.find((g) => g.id === goal.id)?.progress.week_confirmed).toBe(0);
  });
});

describe('acceptance 2: budget boundary entries at Sunday 23:30 / Monday 00:30 local', () => {
  const cases: Array<{
    tz: string;
    sunday2330: string;
    monday0030: string;
  }> = [
    {
      tz: 'America/Chicago',
      sunday2330: '2026-07-27T04:30:00Z',
      monday0030: '2026-07-27T05:30:00Z',
    },
    {
      tz: 'Europe/Berlin',
      sunday2330: '2026-07-26T21:30:00Z',
      monday0030: '2026-07-26T22:30:00Z',
    },
  ];

  for (const c of cases) {
    it(`${c.tz}: Sunday 23:30 counts this week, Monday 00:30 counts next week`, () => {
      const db = freshDb();
      updateCategory(db, 'personal', { timezone: c.tz });
      createProject(db, {
        id: 'spanish',
        name: 'Spanish',
        prefix: 'SPAN',
        category_id: 'personal',
      });
      confirmed(db, 'spanish', c.sunday2330, 30);
      confirmed(db, 'spanish', c.monday0030, 60);

      expect(getProjectBudget(db, 'spanish', WEEK2).confirmed_minutes).toBe(30);
      expect(getProjectBudget(db, 'spanish', WEEK3).confirmed_minutes).toBe(60);
    });
  }
});

describe('acceptance 3: DST weeks are 167h or 169h, and roll up both sides', () => {
  it('the America/Chicago week containing 2026-11-01 spans 169h', () => {
    const range = weekRange('2026-10-26', 'America/Chicago');
    expect(range).toEqual({
      startIso: '2026-10-26T05:00:00Z', // Mon 00:00 CDT
      endIso: '2026-11-02T06:00:00Z', // Mon 00:00 CST
    });
    expect(hoursBetween(range)).toBe(169);
  });

  it('the America/Chicago week containing 2026-03-08 spans 167h', () => {
    const range = weekRange('2026-03-02', 'America/Chicago');
    expect(hoursBetween(range)).toBe(167);
    expect(weekRange('2026-03-02', 'UTC')).toEqual({
      startIso: '2026-03-02T00:00:00Z',
      endIso: '2026-03-09T00:00:00Z',
    });
  });

  it('the Europe/Berlin week containing 2026-10-25 spans 169h', () => {
    expect(hoursBetween(weekRange('2026-10-19', 'Europe/Berlin'))).toBe(169);
  });

  it('entries on both sides of the CST return land in the right weeks', () => {
    const db = setupChicago();
    // Sat 2026-10-31 20:00 CDT (before the change).
    confirmed(db, 'spanish', '2026-11-01T01:00:00Z', 40);
    // Sun 2026-11-01 23:30 CST (after the change, still week 10-26).
    confirmed(db, 'spanish', '2026-11-02T05:30:00Z', 20);
    // Mon 2026-11-02 00:30 CST (week 11-02).
    confirmed(db, 'spanish', '2026-11-02T06:30:00Z', 50);

    expect(getProjectBudget(db, 'spanish', '2026-10-26').confirmed_minutes).toBe(60);
    expect(getProjectBudget(db, 'spanish', '2026-11-02').confirmed_minutes).toBe(50);
    const envelopes = getEnvelopes(db, '2026-10-26');
    expect(envelopes.find((e) => e.envelope_id === 'spanish')?.activity.confirmed_minutes).toBe(60);
  });
});

describe('acceptance 4: supply, envelopes and budgets bound the same instants', () => {
  it('resolved week ranges are equal for the same category and week', () => {
    const db = setupChicago();
    const goal = createGoal(db, {
      project_id: 'spanish',
      title: 'Spanish practice',
      target_minutes: 180,
      refill_period: 'week',
    });
    const habit = createHabit(db, {
      project_id: 'spanish',
      title: 'Flashcards',
      duration_minutes: 15,
      days_of_week: '1,3',
      start_time: '19:00',
      timezone: 'America/Chicago',
    });

    const budget = budgetWeekRange(db, 'spanish', WEEK2);
    const projectEnvelope = envelopeWeekRange(db, 'project', 'spanish', WEEK2);
    const goalEnvelope = envelopeWeekRange(db, 'goal', String(goal.id), WEEK2);
    const habitEnvelope = envelopeWeekRange(db, 'habit', String(habit.id), WEEK2);
    const supply = supplyWeekRange(db, 'personal', WEEK2);

    expect(budget).toEqual(supply);
    expect(projectEnvelope).toEqual(supply);
    expect(goalEnvelope).toEqual(supply);
    expect(habitEnvelope).toEqual(supply);
    expect(supply).toEqual(weekRange(WEEK2, 'America/Chicago'));
    // And the UTC 'work' category is untouched by personal's timezone.
    expect(supplyWeekRange(db, 'work', WEEK2)).toEqual(weekRange(WEEK2, 'UTC'));
  });

  it('a Sunday 23:30 local entry is counted in the same week by all three', () => {
    const db = setupChicago();
    // Sun 23:30-23:59 CDT: outside the personal window (18:00-22:00),
    // so supply self-supplies it as scheduled_outside_minutes.
    confirmed(db, 'spanish', '2026-07-27T04:30:00Z', 29);

    const budget2 = getProjectBudget(db, 'spanish', WEEK2).confirmed_minutes;
    const budget3 = getProjectBudget(db, 'spanish', WEEK3).confirmed_minutes;
    const envelope2 = getEnvelopes(db, WEEK2).find((e) => e.envelope_id === 'spanish')
      ?.activity.confirmed_minutes;
    const envelope3 = getEnvelopes(db, WEEK3).find((e) => e.envelope_id === 'spanish')
      ?.activity.confirmed_minutes;
    const supply2 = computeWeekSupply(db, WEEK2).by_category.find(
      (c) => c.category_id === 'personal',
    )?.scheduled_outside_minutes;
    const supply3 = computeWeekSupply(db, WEEK3).by_category.find(
      (c) => c.category_id === 'personal',
    )?.scheduled_outside_minutes;

    expect(budget2).toBe(29);
    expect(envelope2).toBe(budget2);
    expect(supply2).toBe(budget2);
    expect(budget3).toBe(0);
    expect(envelope3).toBe(budget3);
    expect(supply3).toBe(budget3);
  });

  it('a project with no category behaves as UTC', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO projects (id, name, prefix, category_id) VALUES ('loose', 'Loose', 'LOOS', NULL)`,
    ).run();
    expect(budgetWeekRange(db, 'loose', WEEK2)).toEqual(weekRange(WEEK2, 'UTC'));
    expect(envelopeWeekRange(db, 'project', 'loose', WEEK2)).toEqual(weekRange(WEEK2, 'UTC'));
  });
});
