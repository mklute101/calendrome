import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import {
  createHabit,
  updateHabit,
  listHabits,
  deactivateHabit,
  generateHabitInstances,
  completeHabitInstance,
  skipHabitInstance,
  habitWeekScore,
} from '../src/habits.js';

function setup() {
  const db = freshDb();
  createProject(db, { id: 'me', name: 'Me', prefix: 'ME' });
  return db;
}

describe('habits', () => {
  it('createHabit requires the basic fields', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Journal',
      duration_minutes: 15,
      days_of_week: '1,2,3,4,5',
      start_time: '07:00',
    });
    expect(h.title).toBe('Journal');
    expect(h.duration_minutes).toBe(15);
    expect(h.days_of_week).toBe('1,2,3,4,5');
    expect(h.start_time).toBe('07:00');
    expect(h.active).toBe(1);
  });

  it('rejects invalid days_of_week values', () => {
    const db = setup();
    expect(() =>
      createHabit(db, {
        project_id: 'me',
        title: 'X',
        duration_minutes: 15,
        days_of_week: '1,9',
        start_time: '07:00',
      }),
    ).toThrow();
  });

  it('listHabits filters by active', () => {
    const db = setup();
    const h1 = createHabit(db, {
      project_id: 'me',
      title: 'A',
      duration_minutes: 15,
      days_of_week: '1',
      start_time: '07:00',
    });
    createHabit(db, {
      project_id: 'me',
      title: 'B',
      duration_minutes: 15,
      days_of_week: '2',
      start_time: '07:00',
    });
    deactivateHabit(db, h1.id);

    expect(listHabits(db).length).toBe(2);
    expect(listHabits(db, { active: true }).length).toBe(1);
    expect(listHabits(db, { active: true })[0].title).toBe('B');
  });

  it('generateHabitInstances creates one per matching weekday in the range', () => {
    const db = setup();
    // 2026-04-13 is a Monday. Week of Mon-Fri.
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Standup',
      duration_minutes: 30,
      days_of_week: '1,2,3,4,5',
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
    expect(instances[0].scheduled_start).toBe('2026-04-13T09:00:00Z');
    expect(instances[0].scheduled_end).toBe('2026-04-13T09:30:00Z');
    expect(instances[4].scheduled_start).toBe('2026-04-17T09:00:00Z');
  });

  it('generateHabitInstances is idempotent', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Standup',
      duration_minutes: 30,
      days_of_week: '1',
      start_time: '09:00',
      timezone: 'UTC',
    });
    generateHabitInstances(db, h.id, '2026-04-13', '2026-04-19');
    const second = generateHabitInstances(db, h.id, '2026-04-13', '2026-04-19');
    // No duplicates created
    const all = db
      .prepare('SELECT COUNT(*) as c FROM habit_instances WHERE habit_id = ?')
      .get(h.id) as { c: number };
    expect(all.c).toBe(1);
    // Returns the existing rows on re-run
    expect(second.length).toBe(1);
  });

  it('completeHabitInstance and skipHabitInstance update status', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me',
      title: 'X',
      duration_minutes: 15,
      days_of_week: '1',
      start_time: '07:00',
      timezone: 'UTC',
    });
    const [inst] = generateHabitInstances(db, h.id, '2026-04-13', '2026-04-13');
    const completed = completeHabitInstance(db, inst.id);
    expect(completed.status).toBe('COMPLETE');
    expect(completed.completed_at).toBeTruthy();

    const [inst2] = generateHabitInstances(db, h.id, '2026-04-20', '2026-04-20');
    const skipped = skipHabitInstance(db, inst2.id);
    expect(skipped.status).toBe('SKIPPED');
  });

  it('generateHabitInstances creates paired time_entry rows and links via time_entry_id', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Standup',
      duration_minutes: 30,
      days_of_week: '1,2,3,4,5',
      start_time: '09:00',
      timezone: 'UTC',
    });

    generateHabitInstances(db, h.id, '2026-04-13', '2026-04-17');

    const instances = db
      .prepare(
        `SELECT id, time_entry_id, scheduled_start, scheduled_end
           FROM habit_instances WHERE habit_id = ?`,
      )
      .all(h.id) as Array<{
      id: number;
      time_entry_id: number | null;
      scheduled_start: string;
      scheduled_end: string;
    }>;
    expect(instances.length).toBe(5);
    for (const inst of instances) {
      expect(inst.time_entry_id).not.toBeNull();
      const te = db
        .prepare(
          `SELECT status, source, project_id, start_at, end_at, task_id, notes
             FROM time_entry WHERE id = ?`,
        )
        .get(inst.time_entry_id) as {
        status: string;
        source: string;
        project_id: string | null;
        start_at: string;
        end_at: string;
        task_id: number | null;
        notes: string | null;
      };
      expect(te.status).toBe('UNCONFIRMED');
      expect(te.source).toBe('habit');
      expect(te.project_id).toBe('me');
      expect(te.task_id).toBeNull();
      expect(te.start_at).toBe(inst.scheduled_start);
      expect(te.end_at).toBe(inst.scheduled_end);
      expect(te.notes).toBe('Standup');
    }
  });

  it('generateHabitInstances re-run does not create duplicate time_entry rows', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Standup',
      duration_minutes: 30,
      days_of_week: '1',
      start_time: '09:00',
      timezone: 'UTC',
    });

    generateHabitInstances(db, h.id, '2026-04-13', '2026-04-19');
    const first = db
      .prepare(`SELECT COUNT(*) AS n FROM time_entry WHERE source = 'habit'`)
      .get() as { n: number };

    generateHabitInstances(db, h.id, '2026-04-13', '2026-04-19');
    const second = db
      .prepare(`SELECT COUNT(*) AS n FROM time_entry WHERE source = 'habit'`)
      .get() as { n: number };

    expect(first.n).toBe(1);
    expect(second.n).toBe(1);
  });

  it('completeHabitInstance confirms the paired time_entry', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Standup',
      duration_minutes: 30,
      days_of_week: '1',
      start_time: '09:00',
      timezone: 'UTC',
    });
    const [inst] = generateHabitInstances(db, h.id, '2026-04-13', '2026-04-13');
    const teId = (
      db
        .prepare('SELECT time_entry_id FROM habit_instances WHERE id = ?')
        .get(inst.id) as { time_entry_id: number }
    ).time_entry_id;

    completeHabitInstance(db, inst.id);

    const te = db
      .prepare('SELECT status FROM time_entry WHERE id = ?')
      .get(teId) as { status: string };
    expect(te.status).toBe('CONFIRMED');
  });

  it('skipHabitInstance deletes the paired time_entry and clears the sidecar', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Standup',
      duration_minutes: 30,
      days_of_week: '1',
      start_time: '09:00',
      timezone: 'UTC',
    });
    const [inst] = generateHabitInstances(db, h.id, '2026-04-13', '2026-04-13');
    const teId = (
      db
        .prepare('SELECT time_entry_id FROM habit_instances WHERE id = ?')
        .get(inst.id) as { time_entry_id: number }
    ).time_entry_id;

    skipHabitInstance(db, inst.id);

    const teGone = db
      .prepare('SELECT id FROM time_entry WHERE id = ?')
      .get(teId);
    expect(teGone).toBeUndefined();

    const sidecar = db
      .prepare('SELECT time_entry_id FROM habit_instances WHERE id = ?')
      .get(inst.id) as { time_entry_id: number | null };
    expect(sidecar.time_entry_id).toBeNull();
  });

  it('converts start_time from habit timezone to UTC (CDT example, issue #27)', () => {
    const db = setup();
    // 2026-05-04 is a Monday; America/Chicago is on CDT (UTC-5).
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Lunch',
      duration_minutes: 60,
      days_of_week: '1',
      start_time: '11:30',
      timezone: 'America/Chicago',
    });
    const [inst] = generateHabitInstances(db, h.id, '2026-05-04', '2026-05-04');
    expect(inst.scheduled_start).toBe('2026-05-04T16:30:00Z');
    expect(inst.scheduled_end).toBe('2026-05-04T17:30:00Z');
  });

  it('uses winter offset for habits in CST (UTC-6)', () => {
    const db = setup();
    // 2026-01-05 is a Monday; America/Chicago is on CST (UTC-6).
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Lunch',
      duration_minutes: 60,
      days_of_week: '1',
      start_time: '11:30',
      timezone: 'America/Chicago',
    });
    const [inst] = generateHabitInstances(db, h.id, '2026-01-05', '2026-01-05');
    expect(inst.scheduled_start).toBe('2026-01-05T17:30:00Z');
    expect(inst.scheduled_end).toBe('2026-01-05T18:30:00Z');
  });

  it('handles DST transitions across the range (spring forward 2026-03-08)', () => {
    const db = setup();
    // 2026-03-02 (Mon, CST -6) and 2026-03-09 (Mon, CDT -5) — different UTC times,
    // same 09:00 local wall clock.
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Standup',
      duration_minutes: 30,
      days_of_week: '1',
      start_time: '09:00',
      timezone: 'America/Chicago',
    });
    const instances = generateHabitInstances(db, h.id, '2026-03-02', '2026-03-09');
    expect(instances).toHaveLength(2);
    expect(instances[0].scheduled_start).toBe('2026-03-02T15:00:00Z'); // CST
    expect(instances[1].scheduled_start).toBe('2026-03-09T14:00:00Z'); // CDT
  });

  it('selects weekdays by local date even when UTC time crosses midnight', () => {
    const h_db = setup();
    // 23:00 America/Chicago = 04:00 UTC next calendar day.
    // Friday-only habit. 2026-05-08 is a Friday locally; UTC equivalent is Saturday 04:00.
    const h = createHabit(h_db, {
      project_id: 'me',
      title: 'Late check-in',
      duration_minutes: 30,
      days_of_week: '5',
      start_time: '23:00',
      timezone: 'America/Chicago',
    });
    const instances = generateHabitInstances(h_db, h.id, '2026-05-04', '2026-05-10');
    expect(instances).toHaveLength(1);
    // Expect Friday local → Saturday 04:00 UTC during CDT
    expect(instances[0].scheduled_start).toBe('2026-05-09T04:00:00Z');
  });
});

describe('habits: N-per-week target form (#106)', () => {
  it('createHabit accepts times_per_week (days_of_week stored as empty)', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Workout',
      duration_minutes: 45,
      times_per_week: 4,
      start_time: '17:30',
    });
    expect(h.times_per_week).toBe(4);
    expect(h.days_of_week).toBe('');
  });

  it('requires exactly one of days_of_week / times_per_week', () => {
    const db = setup();
    expect(() =>
      createHabit(db, {
        project_id: 'me',
        title: 'X',
        duration_minutes: 45,
        days_of_week: '1,3',
        times_per_week: 4,
        start_time: '17:30',
      }),
    ).toThrow(/exactly one/);
    expect(() =>
      createHabit(db, {
        project_id: 'me',
        title: 'X',
        duration_minutes: 45,
        start_time: '17:30',
      }),
    ).toThrow(/exactly one/);
    expect(() =>
      createHabit(db, {
        project_id: 'me',
        title: 'X',
        duration_minutes: 45,
        times_per_week: 9,
        start_time: '17:30',
      }),
    ).toThrow(/1\.\.7/);
  });

  it('updateHabit switches forms by setting one side', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Workout',
      duration_minutes: 45,
      days_of_week: '1,2,4,6',
      start_time: '17:30',
    });
    const asTarget = updateHabit(db, h.id, { times_per_week: 4 });
    expect(asTarget.times_per_week).toBe(4);
    expect(asTarget.days_of_week).toBe('');

    const asFixed = updateHabit(db, h.id, { days_of_week: '1,3,5' });
    expect(asFixed.days_of_week).toBe('1,3,5');
    expect(asFixed.times_per_week).toBeNull();
  });

  it('generateHabitInstances materializes N candidates on the first N days', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me',
      title: 'Workout',
      duration_minutes: 45,
      times_per_week: 3,
      start_time: '17:30',
      timezone: 'UTC',
    });
    // 2026-07-13 (Mon) .. 2026-07-19 (Sun)
    const instances = generateHabitInstances(db, h.id, '2026-07-13', '2026-07-19');
    expect(instances).toHaveLength(3);
    expect(instances.map((i) => i.scheduled_start)).toEqual([
      '2026-07-13T17:30:00Z',
      '2026-07-14T17:30:00Z',
      '2026-07-15T17:30:00Z',
    ]);
    // Idempotent: re-run creates no duplicates.
    generateHabitInstances(db, h.id, '2026-07-13', '2026-07-19');
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM habit_instances WHERE habit_id = ?')
      .get(h.id) as { n: number };
    expect(count.n).toBe(3);
  });

  it('habitWeekScore meters COMPLETE instances against the target', () => {
    const db = setup();
    const target = createHabit(db, {
      project_id: 'me',
      title: 'Workout',
      duration_minutes: 45,
      times_per_week: 4,
      start_time: '17:30',
      timezone: 'UTC',
    });
    const instances = generateHabitInstances(db, target.id, '2026-07-13', '2026-07-19');
    completeHabitInstance(db, instances[0].id);
    completeHabitInstance(db, instances[1].id);
    skipHabitInstance(db, instances[2].id);
    expect(habitWeekScore(db, target.id, '2026-07-13')).toEqual({
      done: 2,
      target: 4,
    });

    const fixed = createHabit(db, {
      project_id: 'me',
      title: 'Stretch',
      duration_minutes: 15,
      days_of_week: '1,3,5',
      start_time: '07:00',
      timezone: 'UTC',
    });
    const fixedInstances = generateHabitInstances(db, fixed.id, '2026-07-13', '2026-07-19');
    completeHabitInstance(db, fixedInstances[0].id);
    expect(habitWeekScore(db, fixed.id, '2026-07-13')).toEqual({
      done: 1,
      target: 3,
    });
  });
});
