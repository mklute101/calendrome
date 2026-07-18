import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createGoal } from '../src/goals.js';
import {
  createHabit,
  generateHabitInstances,
  completeHabitInstance,
} from '../src/habits.js';
import { insertTimeEntry } from '../src/time-entry.js';
import {
  assignHours,
  pullHours,
  listMoves,
  getEnvelopes,
  standingDefault,
} from '../src/assignments.js';

// 2026-07-13 is a Monday.
const WEEK = '2026-07-13';

function setup() {
  const db = freshDb();
  createProject(db, {
    id: 'acme',
    name: 'Acme Corp',
    prefix: 'ACME',
    weekly_budget_minutes: 1200,
  });
  createProject(db, {
    id: 'hobby',
    name: 'Hobby',
    prefix: 'HOBBY',
    weekly_budget_minutes: 300,
    category_id: 'personal',
  });
  return db;
}

describe('assignHours', () => {
  it('upserts an assignment row', () => {
    const db = setup();
    const a = assignHours(db, {
      envelope_type: 'project',
      envelope_id: 'acme',
      week_start: WEEK,
      minutes: 900,
      note: 'short week',
    });
    expect(a.minutes).toBe(900);
    expect(a.note).toBe('short week');
    const b = assignHours(db, {
      envelope_type: 'project',
      envelope_id: 'acme',
      week_start: WEEK,
      minutes: 960,
    });
    expect(b.minutes).toBe(960);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM assignments')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('minutes null = snoozed', () => {
    const db = setup();
    const a = assignHours(db, {
      envelope_type: 'project',
      envelope_id: 'hobby',
      week_start: WEEK,
      minutes: null,
      note: 'client paused',
    });
    expect(a.minutes).toBeNull();
  });

  it('rejects a non-Monday week_start and unknown envelopes', () => {
    const db = setup();
    expect(() =>
      assignHours(db, {
        envelope_type: 'project',
        envelope_id: 'acme',
        week_start: '2026-07-15',
        minutes: 60,
      }),
    ).toThrow(/Monday/);
    expect(() =>
      assignHours(db, {
        envelope_type: 'project',
        envelope_id: 'nope',
        week_start: WEEK,
        minutes: 60,
      }),
    ).toThrow(/not found/);
    expect(() =>
      assignHours(db, {
        envelope_type: 'goal',
        envelope_id: '42',
        week_start: WEEK,
        minutes: 60,
      }),
    ).toThrow(/not found/);
    expect(() =>
      assignHours(db, {
        envelope_type: 'widget' as any,
        envelope_id: 'x',
        week_start: WEEK,
        minutes: 60,
      }),
    ).toThrow(/envelope_type/);
  });

  it('rejects negative or fractional minutes', () => {
    const db = setup();
    for (const bad of [-30, 12.5]) {
      expect(() =>
        assignHours(db, {
          envelope_type: 'project',
          envelope_id: 'acme',
          week_start: WEEK,
          minutes: bad,
        }),
      ).toThrow(/minutes/);
    }
  });
});

describe('standingDefault', () => {
  it('project → budget cap (0 when unset); goal → weekly ask; habit → frequency ask', () => {
    const db = setup();
    createProject(db, { id: 'nocap', name: 'No Cap', prefix: 'NOCAP' });
    expect(standingDefault(db, 'project', 'acme', WEEK)).toBe(1200);
    expect(standingDefault(db, 'project', 'nocap', WEEK)).toBe(0);

    const goal = createGoal(db, {
      project_id: 'hobby',
      title: 'Spanish',
      target_minutes: 180,
      refill_period: 'week',
    });
    expect(standingDefault(db, 'goal', String(goal.id), WEEK)).toBe(180);

    const fixed = createHabit(db, {
      project_id: 'hobby',
      title: 'Stretch',
      duration_minutes: 15,
      days_of_week: '0,1,2,3,4,5,6',
      start_time: '07:00',
    });
    expect(standingDefault(db, 'habit', String(fixed.id), WEEK)).toBe(105);

    const target = createHabit(db, {
      project_id: 'hobby',
      title: 'Workout',
      duration_minutes: 45,
      times_per_week: 4,
      start_time: '17:30',
    });
    expect(standingDefault(db, 'habit', String(target.id), WEEK)).toBe(180);
  });
});

describe('pullHours', () => {
  it('moves minutes between envelopes, seeding from standing defaults', () => {
    const db = setup();
    const move = pullHours(db, {
      week_start: WEEK,
      from: { type: 'project', id: 'hobby' },
      to: { type: 'project', id: 'acme' },
      minutes: 120,
      note: 'launch crunch',
    });
    expect(move.minutes).toBe(120);
    expect(move.from_id).toBe('hobby');
    expect(move.to_id).toBe('acme');

    const rows = db
      .prepare('SELECT envelope_id, minutes FROM assignments ORDER BY envelope_id')
      .all() as { envelope_id: string; minutes: number }[];
    // hobby seeded at 300 then −120; acme seeded at 1200 then +120.
    expect(rows).toEqual([
      { envelope_id: 'acme', minutes: 1320 },
      { envelope_id: 'hobby', minutes: 180 },
    ]);
  });

  it('either side null means unassigned supply', () => {
    const db = setup();
    const fund = pullHours(db, {
      week_start: WEEK,
      to: { type: 'project', id: 'acme' },
      minutes: 60,
    });
    expect(fund.from_type).toBeNull();
    expect(fund.to_id).toBe('acme');
    const release = pullHours(db, {
      week_start: WEEK,
      from: { type: 'project', id: 'acme' },
      minutes: 30,
    });
    expect(release.to_type).toBeNull();
    const acme = db
      .prepare(
        "SELECT minutes FROM assignments WHERE envelope_id = 'acme' AND week_start = ?",
      )
      .get(WEEK) as { minutes: number };
    expect(acme.minutes).toBe(1230); // 1200 + 60 − 30

    expect(() => pullHours(db, { week_start: WEEK, minutes: 30 })).toThrow(
      /at least one/,
    );
  });

  it('never goes negative — throws with the shortfall, nothing written', () => {
    const db = setup();
    expect(() =>
      pullHours(db, {
        week_start: WEEK,
        from: { type: 'project', id: 'hobby' }, // standing 300
        to: { type: 'project', id: 'acme' },
        minutes: 360,
      }),
    ).toThrow(/only 300m assigned this week \(short 60m\)/);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM envelope_moves')
      .get() as { n: number };
    expect(count.n).toBe(0);
    const assignments = db
      .prepare('SELECT COUNT(*) AS n FROM assignments')
      .get() as { n: number };
    expect(assignments.n).toBe(0);
  });

  it('a snoozed envelope has 0 to pull from; pulling into it re-funds from 0', () => {
    const db = setup();
    assignHours(db, {
      envelope_type: 'project',
      envelope_id: 'hobby',
      week_start: WEEK,
      minutes: null,
    });
    expect(() =>
      pullHours(db, {
        week_start: WEEK,
        from: { type: 'project', id: 'hobby' },
        minutes: 30,
      }),
    ).toThrow(/only 0m assigned/);
    pullHours(db, {
      week_start: WEEK,
      to: { type: 'project', id: 'hobby' },
      minutes: 45,
    });
    const hobby = db
      .prepare("SELECT minutes FROM assignments WHERE envelope_id = 'hobby'")
      .get() as { minutes: number };
    expect(hobby.minutes).toBe(45);
  });

  it('listMoves returns the week, newest first', () => {
    const db = setup();
    pullHours(db, {
      week_start: WEEK,
      to: { type: 'project', id: 'acme' },
      minutes: 10,
      note: 'first',
    });
    pullHours(db, {
      week_start: WEEK,
      to: { type: 'project', id: 'acme' },
      minutes: 20,
      note: 'second',
    });
    pullHours(db, {
      week_start: '2026-07-20',
      to: { type: 'project', id: 'acme' },
      minutes: 30,
      note: 'other week',
    });
    const moves = listMoves(db, WEEK);
    expect(moves.map((m) => m.note)).toEqual(['second', 'first']);
  });
});

describe('getEnvelopes', () => {
  it('one row per active project, goal, habit — with attribution rules', () => {
    const db = setup();
    const goal = createGoal(db, {
      project_id: 'acme',
      title: 'Prospecting',
      target_minutes: 600,
      due: '2026-08-10', // ask 150/week
    });
    const habit = createHabit(db, {
      project_id: 'hobby',
      title: 'Workout',
      duration_minutes: 45,
      times_per_week: 4,
      start_time: '17:30',
    });
    const instances = generateHabitInstances(db, habit.id, '2026-07-13', '2026-07-19');
    completeHabitInstance(db, instances[0].id);

    // Plain acme work (counts to the project row) ...
    insertTimeEntry(db, {
      project_id: 'acme',
      start_at: '2026-07-14T09:00:00Z',
      end_at: '2026-07-14T12:00:00Z',
      status: 'CONFIRMED',
      source: 'manual',
    });
    // ... and goal-linked acme work (counts to the goal row only).
    insertTimeEntry(db, {
      project_id: 'acme',
      goal_id: goal.id,
      start_at: '2026-07-15T09:00:00Z',
      end_at: '2026-07-15T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });

    const rows = getEnvelopes(db, WEEK);
    const byKey = new Map(rows.map((r) => [`${r.envelope_type}:${r.envelope_id}`, r]));
    expect(rows.length).toBe(4); // acme, hobby, goal, habit

    const acme = byKey.get('project:acme')!;
    expect(acme.title).toBe('Acme Corp');
    expect(acme.assigned).toBe(1200);
    // Goal-linked and habit entries are NOT double-counted here.
    expect(acme.activity).toEqual({ confirmed_minutes: 180, scheduled_minutes: 0 });
    expect(acme.available).toBe(1020);
    expect(acme.funding).toBe('on_track');
    expect(acme.status_line).toBe('On track');

    const goalRow = byKey.get(`goal:${goal.id}`)!;
    expect(goalRow.activity).toEqual({ confirmed_minutes: 0, scheduled_minutes: 60 });
    expect(goalRow.assigned).toBe(150);
    expect(goalRow.funding).toBe('underfunded');
    expect(goalRow.status_line).toBe('1.5h more needed this week');

    const habitRow = byKey.get(`habit:${habit.id}`)!;
    // 4 instances × 45min: 1 confirmed (completed), 3 still scheduled.
    expect(habitRow.activity).toEqual({
      confirmed_minutes: 45,
      scheduled_minutes: 135,
    });
    expect(habitRow.week_score).toEqual({ done: 1, target: 4 });
    expect(habitRow.funding).toBe('on_track');
  });

  it('overspent and snoozed funding states', () => {
    const db = setup();
    // hobby cap 300, activity 330 → overspent.
    insertTimeEntry(db, {
      project_id: 'hobby',
      start_at: '2026-07-14T18:00:00Z',
      end_at: '2026-07-14T23:30:00Z',
      status: 'CONFIRMED',
      source: 'manual',
    });
    assignHours(db, {
      envelope_type: 'project',
      envelope_id: 'acme',
      week_start: WEEK,
      minutes: null,
    });
    const rows = getEnvelopes(db, WEEK);
    const hobby = rows.find((r) => r.envelope_id === 'hobby')!;
    expect(hobby.funding).toBe('overspent');
    expect(hobby.status_line).toBe('Overspent: 5.5h of 5h');
    expect(hobby.available).toBe(-30);

    const acme = rows.find((r) => r.envelope_id === 'acme')!;
    expect(acme.funding).toBe('snoozed');
    expect(acme.assigned).toBeNull();
    expect(acme.status_line).toBe('Snoozed this week');
  });

  // The caps-vs-floors law (#119): a project cap nags down only —
  // never 'underfunded', there's no virtue in hitting a cap exactly.
  // A goal/habit floor nags up only — never 'overspent' for
  // over-doing, even past an explicit assignment.
  it('caps nag down only: a cap under its assignment is on_track, never underfunded', () => {
    const db = setup();
    // acme cap 1200, zero activity — YNAB would call that "underfunded";
    // a bare cap must not.
    const acme = getEnvelopes(db, WEEK).find((r) => r.envelope_id === 'acme')!;
    expect(acme.funding).toBe('on_track');
    expect(acme.needed_minutes).toBe(0);
  });

  it('floors nag up only: activity past the ask/assignment is never overspent', () => {
    const db = setup();
    const goal = createGoal(db, {
      project_id: 'hobby',
      title: 'Spanish',
      target_minutes: 180,
      refill_period: 'week',
    });
    // 4h confirmed against a 3h ask, with an explicit 2h assignment —
    // both "overages" are over-doing a floor, which is fine.
    insertTimeEntry(db, {
      project_id: 'hobby',
      goal_id: goal.id,
      start_at: '2026-07-14T18:00:00Z',
      end_at: '2026-07-14T22:00:00Z',
      status: 'CONFIRMED',
      source: 'manual',
    });
    assignHours(db, {
      envelope_type: 'goal',
      envelope_id: String(goal.id),
      week_start: WEEK,
      minutes: 120,
    });

    // Same shape for a habit floor: 45m scheduled, assignment cut to 30m.
    const habit = createHabit(db, {
      project_id: 'hobby',
      title: 'Workout',
      duration_minutes: 45,
      times_per_week: 1,
      start_time: '17:30',
    });
    generateHabitInstances(db, habit.id, '2026-07-13', '2026-07-19');
    assignHours(db, {
      envelope_type: 'habit',
      envelope_id: String(habit.id),
      week_start: WEEK,
      minutes: 30,
    });

    const rows = getEnvelopes(db, WEEK);
    const goalRow = rows.find(
      (r) => r.envelope_type === 'goal' && r.envelope_id === String(goal.id),
    )!;
    expect(goalRow.needed_minutes).toBe(0);
    expect(goalRow.funding).toBe('on_track');
    expect(goalRow.status_line).toBe('On track');

    const habitRow = rows.find(
      (r) => r.envelope_type === 'habit' && r.envelope_id === String(habit.id),
    )!;
    expect(habitRow.needed_minutes).toBe(0);
    expect(habitRow.funding).toBe('on_track');

    // A floor with an uncovered ask is still underfunded, with the
    // status line and needed_minutes on the same intrinsic basis.
    const partial = createGoal(db, {
      project_id: 'hobby',
      title: 'Guitar',
      target_minutes: 480,
      refill_period: 'week',
    });
    insertTimeEntry(db, {
      project_id: 'hobby',
      goal_id: partial.id,
      start_at: '2026-07-16T18:00:00Z',
      end_at: '2026-07-16T21:00:00Z',
      status: 'CONFIRMED',
      source: 'manual',
    });
    const partialRow = getEnvelopes(db, WEEK).find(
      (r) => r.envelope_type === 'goal' && r.envelope_id === String(partial.id),
    )!;
    expect(partialRow.funding).toBe('underfunded');
    expect(partialRow.needed_minutes).toBe(300); // 8h ask − 3h done
    expect(partialRow.status_line).toBe('5h more needed this week');
  });

  it('explicit assignment overrides the standing default', () => {
    const db = setup();
    assignHours(db, {
      envelope_type: 'project',
      envelope_id: 'acme',
      week_start: WEEK,
      minutes: 900,
    });
    const acme = getEnvelopes(db, WEEK).find((r) => r.envelope_id === 'acme')!;
    expect(acme.assigned).toBe(900);
  });
});
