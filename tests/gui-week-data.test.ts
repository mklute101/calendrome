import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { buildTools } from '../src/mcp/tools/index.js';
import { FakeCalendarClient } from '../src/calendar/fake.js';
import { buildWeekPayload } from '../src/gui/week-data.js';
import {
  createHabit,
  generateHabitInstances,
  moveHabitInstance,
  skipHabitInstance,
} from '../src/habits.js';
import { buildDays } from '../src/gui/app/lib/weekdays.js';
import { assignHours } from '../src/assignments.js';

/**
 * GUI week payload tests (#79).
 *
 * The dashboard positions blocks from `time_entry` rows — `placements`
 * for UNCONFIRMED (planned) work, `time_logs` for CONFIRMED (done)
 * work. `task.due` is a pure deadline and never positions a block, so
 * unplacing a task must leave no ghost behind.
 */

const WEEK = '2026-06-15'; // Monday
const SLOT = '2026-06-16T10:00:00Z';

function getTool(tools: any[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function setup() {
  const db = freshDb();
  createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
  const tools = buildTools(db, { calendar: new FakeCalendarClient() });
  return { db, tools };
}

describe('buildWeekPayload placements', () => {
  it('unplace leaves no ghost: re-placing another task at the same slot yields one block', async () => {
    const { db, tools } = setup();
    const a = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Task A',
      duration_minutes: 60,
    });
    const b = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Task B',
      duration_minutes: 60,
    });

    await getTool(tools, 'place_task').handler({ task_id: a.task.id, start: SLOT });
    await getTool(tools, 'unplace_task').handler({ task_id: a.task.id });
    await getTool(tools, 'place_task').handler({ task_id: b.task.id, start: SLOT });

    const payload = buildWeekPayload(db, WEEK);
    const atSlot = payload.placements.filter((p: any) => p.start_at === SLOT);
    expect(atSlot).toHaveLength(1);
    expect(atSlot[0].task_title).toBe('Task B');
  });

  it('place then unplace leaves task.due untouched', async () => {
    const { db, tools } = setup();
    const deadline = '2026-06-19T00:00:00Z';
    const t = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Deadline task',
      duration_minutes: 60,
      due: deadline,
    });

    const placed = await getTool(tools, 'place_task').handler({
      task_id: t.task.id,
      start: SLOT,
    });
    expect(placed.task.due).toBe(deadline);

    const cleared = await getTool(tools, 'unplace_task').handler({
      task_id: t.task.id,
    });
    expect(cleared.task.due).toBe(deadline);
  });

  it('a NEW task with a user-set due is never a placement — only a task (deadline marker)', async () => {
    const { db, tools } = setup();
    await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Just a deadline',
      duration_minutes: 60,
      due: '2026-06-18T17:00:00Z',
    });

    const payload = buildWeekPayload(db, WEEK);
    expect(payload.placements).toHaveLength(0);
    const titles = payload.tasks.map((t: any) => t.title);
    expect(titles).toContain('Just a deadline');
  });

  it('confirmed placements move from placements to time_logs', async () => {
    const { db, tools } = setup();
    const t = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Done work',
      duration_minutes: 60,
    });
    const placed = await getTool(tools, 'place_task').handler({
      task_id: t.task.id,
      start: SLOT,
    });

    let payload = buildWeekPayload(db, WEEK);
    expect(payload.placements).toHaveLength(1);
    expect(payload.time_logs).toHaveLength(0);

    await getTool(tools, 'confirm_placement').handler({
      time_entry_id: placed.time_entry_id,
      actual_minutes: 45,
    });

    payload = buildWeekPayload(db, WEEK);
    expect(payload.placements).toHaveLength(0);
    expect(payload.time_logs).toHaveLength(1);
    expect(payload.time_logs[0].task_title).toBe('Done work');
    expect(payload.time_logs[0].duration_minutes).toBe(45);
  });
});

describe('buildWeekPayload goal blocks (#111 review)', () => {
  it('task-less goal placements render: goal_title + project from the goal', async () => {
    const { db, tools } = setup();
    const g = await getTool(tools, 'create_goal').handler({
      project_id: 'acme',
      title: 'Prospecting',
      target_minutes: 600,
      due: '2026-07-13',
    });

    await getTool(tools, 'place_goal_block').handler({
      goal_id: g.goal.id,
      start: SLOT,
      duration_minutes: 60,
    });

    const payload = buildWeekPayload(db, WEEK);
    expect(payload.placements).toHaveLength(1);
    const p = payload.placements[0];
    expect(p.task_id).toBeNull();
    expect(p.goal_id).toBe(g.goal.id);
    expect(p.goal_title).toBe('Prospecting');
    expect(p.project_id).toBe('acme');
  });

  it('confirmed goal hours surface in time_logs with the goal title', async () => {
    const { db, tools } = setup();
    const g = await getTool(tools, 'create_goal').handler({
      project_id: 'acme',
      title: 'Spanish practice',
      target_minutes: 180,
      refill_period: 'week',
    });

    const placed = await getTool(tools, 'place_goal_block').handler({
      goal_id: g.goal.id,
      start: SLOT,
      duration_minutes: 60,
    });
    await getTool(tools, 'confirm_placement').handler({
      time_entry_id: placed.entry.id,
    });

    const payload = buildWeekPayload(db, WEEK);
    expect(payload.placements).toHaveLength(0);
    expect(payload.time_logs).toHaveLength(1);
    expect(payload.time_logs[0].goal_title).toBe('Spanish practice');
    expect(payload.time_logs[0].goal_id).toBe(g.goal.id);
  });
});

describe('buildWeekPayload habit instances (#118)', () => {
  it('a moved instance carries the entry span as start_at/end_at and buckets on its new day', () => {
    const { db } = setup();
    const habit = createHabit(db, {
      project_id: 'acme',
      title: 'Workout',
      duration_minutes: 45,
      times_per_week: 2,
      start_time: '09:00',
      timezone: 'UTC',
    });
    const [inst] = generateHabitInstances(db, habit.id, WEEK, '2026-06-21');
    moveHabitInstance(db, inst.id, '2026-06-20T10:00:00Z'); // Mon → Sat

    const payload = buildWeekPayload(db, WEEK);
    // Rebuilding regenerated for the week — still exactly 2 instances
    // (dedupe keys off the untouched scheduled_start).
    expect(payload.habit_instances).toHaveLength(2);
    const moved = payload.habit_instances.find((h: any) => h.id === inst.id);
    expect(moved.scheduled_start).toBe('2026-06-15T09:00:00Z'); // slot identity
    expect(moved.start_at).toBe('2026-06-20T10:00:00Z'); // display truth
    expect(moved.end_at).toBe('2026-06-20T10:45:00Z');
    expect(moved.times_per_week).toBe(2);

    // buildDays buckets by start_at: the block lands on Saturday.
    const days = buildDays(payload as any, WEEK);
    expect(days[0].habits.map((h: any) => h.id)).not.toContain(inst.id);
    expect(days[5].habits.map((h: any) => h.id)).toContain(inst.id);
  });

  it('SKIPPED stays in the payload (weekly meter) but buildDays filters it out', () => {
    const { db } = setup();
    const habit = createHabit(db, {
      project_id: 'acme',
      title: 'Stretch',
      duration_minutes: 15,
      days_of_week: '1', // Monday
      start_time: '07:00',
      timezone: 'UTC',
    });
    const [inst] = generateHabitInstances(db, habit.id, WEEK, WEEK);
    skipHabitInstance(db, inst.id);

    // Exclusion is deliberately client-side (buildDays), so the payload
    // keeps the row — the weekly meter and any future skip surfacing
    // need it. The COALESCE falls back to the scheduled slot since the
    // skip deleted the linked entry.
    const payload = buildWeekPayload(db, WEEK);
    const skipped = payload.habit_instances.find((h: any) => h.id === inst.id);
    expect(skipped).toBeDefined();
    expect(skipped.status).toBe('SKIPPED');
    expect(skipped.start_at).toBe('2026-06-15T07:00:00Z');

    const days = buildDays(payload as any, WEEK);
    expect(days.every((d) => !d.habits.some((h: any) => h.id === inst.id))).toBe(true);
  });
});

describe('buildWeekPayload commitments (M1 — watchable)', () => {
  it('embeds active goals with their goalProgress for the week', async () => {
    const { db, tools } = setup();
    const g = await getTool(tools, 'create_goal').handler({
      project_id: 'acme',
      title: 'Spanish practice',
      target_minutes: 180,
      refill_period: 'week',
    });
    await getTool(tools, 'place_goal_block').handler({
      goal_id: g.goal.id,
      start: SLOT,
      duration_minutes: 60,
    });

    const payload = buildWeekPayload(db, WEEK);
    expect(payload.goals).toHaveLength(1);
    const goal = payload.goals[0];
    expect(goal.title).toBe('Spanish practice');
    expect(goal.progress.flavor).toBe('refill');
    expect(goal.progress.week_scheduled).toBe(60);
    expect(goal.progress.needed_this_week).toBe(120);
  });

  it('inactive goals stay out of the payload', async () => {
    const { db, tools } = setup();
    const g = await getTool(tools, 'create_goal').handler({
      project_id: 'acme',
      title: 'Old goal',
      target_minutes: 60,
      refill_period: 'week',
    });
    await getTool(tools, 'deactivate_goal').handler({ id: g.goal.id });
    expect(buildWeekPayload(db, WEEK).goals).toHaveLength(0);
  });

  it('habit_scores carries the weekly meter per active habit', () => {
    const { db } = setup();
    const habit = createHabit(db, {
      project_id: 'acme',
      title: 'Stretch',
      duration_minutes: 15,
      days_of_week: '1,3,5',
      start_time: '07:00',
    });

    const payload = buildWeekPayload(db, WEEK);
    expect(payload.habit_scores).toEqual([
      {
        habit_id: habit.id,
        title: 'Stretch',
        project_id: 'acme',
        done: 0,
        target: 3,
      },
    ]);
  });

  it('envelope_summary sums assigned/confirmed/scheduled over the envelopes', async () => {
    const { db, tools } = setup();
    const g = await getTool(tools, 'create_goal').handler({
      project_id: 'acme',
      title: 'Prospecting',
      target_minutes: 180,
      refill_period: 'week',
    });
    // Explicit project assignment + the goal's standing weekly ask.
    assignHours(db, {
      envelope_type: 'project',
      envelope_id: 'acme',
      week_start: WEEK,
      minutes: 600,
    });
    const placed = await getTool(tools, 'place_goal_block').handler({
      goal_id: g.goal.id,
      start: SLOT,
      duration_minutes: 90,
    });
    await getTool(tools, 'confirm_placement').handler({
      time_entry_id: placed.entry.id,
      actual_minutes: 60,
    });

    const summary = buildWeekPayload(db, WEEK).envelope_summary;
    expect(summary).toEqual({
      assigned_minutes: 600 + 180,
      confirmed_minutes: 60,
      scheduled_minutes: 0,
    });
  });

  it('a mid-week start answers for its own Monday instead of throwing', async () => {
    const { db, tools } = setup();
    await getTool(tools, 'create_goal').handler({
      project_id: 'acme',
      title: 'Spanish practice',
      target_minutes: 180,
      refill_period: 'week',
    });

    const payload = buildWeekPayload(db, '2026-06-17'); // Wednesday
    expect(payload.goals[0].progress.week_start).toBe(WEEK);
  });
});
