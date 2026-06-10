import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { buildTools } from '../src/mcp/tools/index.js';
import { FakeCalendarClient } from '../src/calendar/fake.js';
import { buildWeekPayload } from '../src/gui/week-data.js';

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
