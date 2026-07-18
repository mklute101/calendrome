import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { FakeCalendarClient } from '../src/calendar/index.js';
import { createTask, getTask } from '../src/tasks.js';
import { insertTimeEntry } from '../src/time-entry.js';
import {
  guiPlace,
  guiMove,
  guiConfirm,
  guiSkip,
  guiUnplace,
  guiComplete,
  reopenTask,
  guiSnooze,
  guiAssign,
  guiPull,
  guiHabitComplete,
  guiHabitSkip,
  guiHabitMove,
  reopenHabitInstance,
} from '../src/gui/mutations.js';
import { createHabit, generateHabitInstances } from '../src/habits.js';

function setup() {
  const db = freshDb();
  db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('acme', 'Acme', 'ACME')`).run();
  const calendar = new FakeCalendarClient();
  const task = createTask(db, {
    project_id: 'acme',
    title: 'Fix login bug',
    duration_minutes: 90,
  });
  return { db, calendar, task };
}

describe('GUI mutations (#24, #86)', () => {
  it('guiPlace creates event + UNCONFIRMED placement and schedules the task', async () => {
    const { db, calendar, task } = setup();
    const result = await guiPlace(db, calendar, {
      task_id: task.id,
      start: '2026-07-13T09:00:00Z',
    });

    expect(calendar.events).toHaveLength(1);
    expect(result.task.status).toBe('SCHEDULED');
    const row = db
      .prepare(`SELECT * FROM time_entry WHERE id = ?`)
      .get(result.time_entry_id) as any;
    expect(row.status).toBe('UNCONFIRMED');
    expect(row.source).toBe('placement');
    expect(row.start_at).toBe('2026-07-13T09:00:00Z');
    expect(row.end_at).toBe('2026-07-13T10:30:00Z'); // 90 min duration
  });

  it('guiPlace with explicit end overrides task duration (undo-of-skip path)', async () => {
    const { db, calendar, task } = setup();
    const result = await guiPlace(db, calendar, {
      task_id: task.id,
      start: '2026-07-13T09:00:00Z',
      end: '2026-07-13T09:45:00Z',
    });
    const row = db
      .prepare(`SELECT end_at FROM time_entry WHERE id = ?`)
      .get(result.time_entry_id) as any;
    expect(row.end_at).toBe('2026-07-13T09:45:00Z');
  });

  it('guiPlace throws 404-shaped error on unknown task and rejects bad start', async () => {
    const { db, calendar } = setup();
    await expect(
      guiPlace(db, calendar, { task_id: 999, start: '2026-07-13T09:00:00Z' }),
    ).rejects.toThrow(/not found/);
    const { task } = setup();
    await expect(
      guiPlace(db, calendar, { task_id: task.id, start: 'nonsense' }),
    ).rejects.toThrow(/ISO 8601/);
  });

  it('guiMove moves a placement preserving duration; explicit end resizes', async () => {
    const { db, calendar, task } = setup();
    const { time_entry_id } = await guiPlace(db, calendar, {
      task_id: task.id,
      start: '2026-07-13T09:00:00Z',
    });

    const moved = guiMove(db, time_entry_id, { start: '2026-07-14T14:00:00Z' });
    expect(moved.placement.start_at).toBe('2026-07-14T14:00:00Z');
    expect(moved.placement.end_at).toBe('2026-07-14T15:30:00Z');

    const resized = guiMove(db, time_entry_id, {
      start: '2026-07-14T14:00:00Z',
      end: '2026-07-14T16:00:00Z',
    });
    expect(resized.placement.end_at).toBe('2026-07-14T16:00:00Z');
  });

  it('guiMove guards: CONFIRMED, gcal-sync, and manual entries refuse', async () => {
    const { db } = setup();
    const confirmed = insertTimeEntry(db, {
      project_id: 'acme',
      start_at: '2026-07-13T09:00:00Z',
      end_at: '2026-07-13T10:00:00Z',
      status: 'CONFIRMED',
      confirmed_at: '2026-07-13T10:00:00Z',
      source: 'manual',
    });
    expect(() => guiMove(db, confirmed, { start: '2026-07-13T11:00:00Z' })).toThrow(
      /confirmed/i,
    );
    const gcal = insertTimeEntry(db, {
      start_at: '2026-07-13T09:00:00Z',
      end_at: '2026-07-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'gcal-sync',
      external_id: 'evt-x',
    });
    expect(() => guiMove(db, gcal, { start: '2026-07-13T11:00:00Z' })).toThrow(/gcal/i);
    expect(() => guiMove(db, 9999, { start: '2026-07-13T11:00:00Z' })).toThrow(
      /not found/,
    );
  });

  it('guiConfirm confirms and is idempotent', async () => {
    const { db, calendar, task } = setup();
    const { time_entry_id } = await guiPlace(db, calendar, {
      task_id: task.id,
      start: '2026-07-13T09:00:00Z',
    });
    const first = guiConfirm(db, time_entry_id, { actual_minutes: 75 });
    expect(first.time_entry.status).toBe('CONFIRMED');
    expect(first.time_entry.actual_minutes).toBe(75);
    expect(() => guiConfirm(db, time_entry_id, {})).not.toThrow();
  });

  it('guiSkip deletes the placement and returns the span for undo', async () => {
    const { db, calendar, task } = setup();
    const { time_entry_id } = await guiPlace(db, calendar, {
      task_id: task.id,
      start: '2026-07-13T09:00:00Z',
    });
    const { deleted } = guiSkip(db, time_entry_id);
    expect(deleted).toEqual({
      task_id: task.id,
      start_at: '2026-07-13T09:00:00Z',
      end_at: '2026-07-13T10:30:00Z',
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM time_entry WHERE id = ?`).get(time_entry_id),
    ).toEqual({ n: 0 });
  });

  it('guiUnplace removes the event + row, resets to NEW, and returns the prior span', async () => {
    const { db, calendar, task } = setup();
    await guiPlace(db, calendar, { task_id: task.id, start: '2026-07-13T09:00:00Z' });

    const result = await guiUnplace(db, calendar, task.id);
    expect(result.task.status).toBe('NEW');
    expect(result.was).toEqual({
      start_at: '2026-07-13T09:00:00Z',
      end_at: '2026-07-13T10:30:00Z',
    });
    expect(calendar.events).toHaveLength(0);
  });

  it('guiUnplace refuses when the placement is CONFIRMED', async () => {
    const { db, calendar, task } = setup();
    const { time_entry_id } = await guiPlace(db, calendar, {
      task_id: task.id,
      start: '2026-07-13T09:00:00Z',
    });
    guiConfirm(db, time_entry_id, {});
    await expect(guiUnplace(db, calendar, task.id)).rejects.toThrow(/CONFIRMED/);
  });

  it('guiComplete completes; reopenTask reverses it; reopen refuses non-COMPLETE', () => {
    const { db, task } = setup();
    const { task: done } = guiComplete(db, task.id);
    expect(done.status).toBe('COMPLETE');

    const { task: reopened } = reopenTask(db, task.id, 'NEW');
    expect(reopened.status).toBe('NEW');
    expect(getTask(db, task.id)!.status).toBe('NEW');

    expect(() => reopenTask(db, task.id, 'NEW')).toThrow(/not COMPLETE/);
  });

  it('guiSnooze sets and clears snooze_until without touching status', () => {
    const { db, task } = setup();
    const { task: snoozed } = guiSnooze(db, task.id, '2026-07-20');
    expect(snoozed.snooze_until).toBe('2026-07-20');
    expect(snoozed.status).toBe('NEW');
    const { task: cleared } = guiSnooze(db, task.id, null);
    expect(cleared.snooze_until).toBeNull();
  });
});

describe('GUI habit-instance mutations (#118)', () => {
  function habitSetup() {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('me', 'Me', 'ME')`).run();
    const habit = createHabit(db, {
      project_id: 'me',
      title: 'Stretch',
      duration_minutes: 30,
      days_of_week: '1', // Monday
      start_time: '09:00',
      timezone: 'UTC',
    });
    // 2026-07-13 is a Monday.
    const [inst] = generateHabitInstances(db, habit.id, '2026-07-13', '2026-07-13');
    return { db, habit, inst };
  }

  it('guiHabitComplete completes; reopenHabitInstance un-confirms in place', () => {
    const { db, inst } = habitSetup();
    const { instance } = guiHabitComplete(db, inst.id);
    expect(instance.status).toBe('COMPLETE');
    expect(instance.completed_at).toBeTruthy();
    const te = db
      .prepare('SELECT status FROM time_entry WHERE id = ?')
      .get(instance.time_entry_id) as { status: string };
    expect(te.status).toBe('CONFIRMED');

    // Undo: back to PLANNED, entry un-confirmed, same entry row kept.
    const { instance: reopened } = reopenHabitInstance(db, inst.id);
    expect(reopened.status).toBe('PLANNED');
    expect(reopened.completed_at).toBeNull();
    expect(reopened.time_entry_id).toBe(instance.time_entry_id);
    const back = db
      .prepare('SELECT status, confirmed_at FROM time_entry WHERE id = ?')
      .get(instance.time_entry_id) as { status: string; confirmed_at: string | null };
    expect(back.status).toBe('UNCONFIRMED');
    expect(back.confirmed_at).toBeNull();
  });

  it('guiHabitSkip skips; reopenHabitInstance re-inserts the entry at the scheduled slot', () => {
    const { db, inst } = habitSetup();
    const priorEntryId = inst.time_entry_id;
    const { instance } = guiHabitSkip(db, inst.id);
    expect(instance.status).toBe('SKIPPED');
    expect(instance.time_entry_id).toBeNull();

    const { instance: reopened } = reopenHabitInstance(db, inst.id);
    expect(reopened.status).toBe('PLANNED');
    expect(reopened.time_entry_id).not.toBeNull();
    expect(reopened.time_entry_id).not.toBe(priorEntryId); // fresh row
    const te = db
      .prepare('SELECT * FROM time_entry WHERE id = ?')
      .get(reopened.time_entry_id) as any;
    expect(te.status).toBe('UNCONFIRMED');
    expect(te.source).toBe('habit');
    expect(te.start_at).toBe('2026-07-13T09:00:00Z'); // scheduled slot
    expect(te.end_at).toBe('2026-07-13T09:30:00Z');
    expect(te.notes).toBe('Stretch');
  });

  it('guiHabitMove wraps moveHabitInstance (range rule included)', () => {
    const { db, inst } = habitSetup();
    const { instance, entry } = guiHabitMove(db, inst.id, {
      start: '2026-07-13T18:00:00Z',
    });
    expect(instance.scheduled_start).toBe('2026-07-13T09:00:00Z'); // untouched
    expect(entry.start_at).toBe('2026-07-13T18:00:00Z');
    expect(() =>
      guiHabitMove(db, inst.id, { start: '2026-07-14T09:00:00Z' }),
    ).toThrow(/skip, not a move/);
  });

  it('guards: non-PLANNED refuses ✓/✕, PLANNED refuses reopen, unknown id 404-shapes', () => {
    const { db, inst } = habitSetup();
    expect(() => reopenHabitInstance(db, inst.id)).toThrow(/already PLANNED/);
    guiHabitComplete(db, inst.id);
    expect(() => guiHabitComplete(db, inst.id)).toThrow(/not PLANNED/);
    expect(() => guiHabitSkip(db, inst.id)).toThrow(/not PLANNED/);
    expect(() => guiHabitComplete(db, 9999)).toThrow(/not found/);
    expect(() => reopenHabitInstance(db, 9999)).toThrow(/not found/);
  });
});

describe('GUI budget mutations (#106 M2)', () => {
  function budgetSetup() {
    const db = freshDb();
    db.prepare(
      `INSERT INTO projects (id, name, prefix, weekly_budget_minutes)
       VALUES ('acme', 'Acme', 'ACME', 1200), ('hobby', 'Hobby', 'HOBBY', 300)`,
    ).run();
    return { db };
  }
  const WEEK = '2026-07-13'; // Monday

  it('guiAssign upserts the assignment row (and null snoozes)', () => {
    const { db } = budgetSetup();
    const { assignment } = guiAssign(db, {
      envelope_type: 'project',
      envelope_id: 'acme',
      week_start: WEEK,
      minutes: 600,
      note: 'light week',
    });
    expect(assignment.minutes).toBe(600);
    expect(assignment.note).toBe('light week');

    const { assignment: snoozed } = guiAssign(db, {
      envelope_type: 'project',
      envelope_id: 'acme',
      week_start: WEEK,
      minutes: null,
    });
    expect(snoozed.minutes).toBeNull();
  });

  it('guiPull moves minutes and the reverse pull (the undo) restores both sides', () => {
    const { db } = budgetSetup();
    const { move } = guiPull(db, {
      week_start: WEEK,
      from: { type: 'project', id: 'hobby' },
      to: { type: 'project', id: 'acme' },
      minutes: 120,
      note: 'launch crunch',
    });
    expect(move.from_id).toBe('hobby');
    expect(move.to_id).toBe('acme');
    expect(move.minutes).toBe(120);

    const minutesOf = (id: string) =>
      (
        db
          .prepare(
            'SELECT minutes FROM assignments WHERE envelope_id = ? AND week_start = ?',
          )
          .get(id, WEEK) as { minutes: number }
      ).minutes;
    expect(minutesOf('hobby')).toBe(180); // 300 − 120
    expect(minutesOf('acme')).toBe(1320); // 1200 + 120

    // Undo = reverse pull, from/to swapped. Must be accepted cleanly:
    // the forward pull left acme holding the minutes to give back.
    const { move: undo } = guiPull(db, {
      week_start: WEEK,
      from: { type: 'project', id: 'acme' },
      to: { type: 'project', id: 'hobby' },
      minutes: 120,
      note: 'undo',
    });
    expect(undo.note).toBe('undo');
    expect(minutesOf('hobby')).toBe(300);
    expect(minutesOf('acme')).toBe(1200);
  });

  it('guiPull surfaces core guards (overdraw throws)', () => {
    const { db } = budgetSetup();
    expect(() =>
      guiPull(db, {
        week_start: WEEK,
        from: { type: 'project', id: 'hobby' },
        to: { type: 'project', id: 'acme' },
        minutes: 999,
      }),
    ).toThrow(/only 300m assigned/);
  });
});
