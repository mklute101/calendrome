import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import {
  createHabit,
  listHabits,
  deactivateHabit,
  generateHabitInstances,
  completeHabitInstance,
  skipHabitInstance,
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
});
