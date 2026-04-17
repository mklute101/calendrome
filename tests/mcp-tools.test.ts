import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { buildTools } from '../src/mcp/tools/index.js';
import { FakeCalendarClient } from '../src/calendar/fake.js';

/**
 * MCP tools layer tests.
 *
 * `buildTools(db)` returns an array of tool descriptors with shape:
 *   { name, description, inputSchema, handler }
 * where `handler(args)` returns a structured response. Tests exercise the
 * handlers directly (not over JSON-RPC) so they're fast and deterministic.
 */

function getTool(tools: any[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe('MCP tools layer', () => {
  it('exposes the expected tool surface', () => {
    const db = freshDb();
    const tools = buildTools(db);
    const names = tools.map((t: any) => t.name).sort();

    for (const expected of [
      'create_project',
      'list_projects',
      'create_task',
      'update_task',
      'list_tasks',
      'search_tasks',
      'start_task',
      'stop_task',
      'complete_task',
      'inbox_add',
      'inbox_list',
      'inbox_next',
      'inbox_process',
      'create_habit',
      'list_habits',
      'generate_habit_instances',
      'get_project_budget',
      'get_all_budgets',
      'get_week_layout',
      'export_timesheet',
      'get_timesheet_summary',
      'place_task',
      'unplace_task',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('every tool has a name, description, inputSchema and handler', () => {
    const db = freshDb();
    const tools = buildTools(db);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema).toBeTruthy();
      expect(typeof t.handler).toBe('function');
    }
  });

  it('create_project handler creates a project', async () => {
    const db = freshDb();
    const tools = buildTools(db);
    const create = getTool(tools, 'create_project');
    const result = await create.handler({
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      weekly_budget_minutes: 1200,
    });
    expect(result.project.id).toBe('acme');
    expect(result.project.weekly_budget_minutes).toBe(1200);
  });

  it('create_task handler creates a task within a project', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);
    const create = getTool(tools, 'create_task');
    const result = await create.handler({ project_id: 'acme', title: 'X' });
    expect(result.task.title).toBe('X');
    expect(result.task.project_id).toBe('acme');
  });

  it('start_task / stop_task / complete_task handlers work end-to-end', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);

    const created = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'X',
    });
    const id = created.task.id;

    await getTool(tools, 'start_task').handler({ id });
    await getTool(tools, 'stop_task').handler({ id });
    const done = await getTool(tools, 'complete_task').handler({ id });
    expect(done.task.status).toBe('COMPLETE');
  });

  it('place_task creates an event on the project calendar via FakeCalendarClient', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      calendar_id: 'cal-acme',
    });

    const calendar = new FakeCalendarClient();
    const tools = buildTools(db, { calendar });

    const t = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Report',
      duration_minutes: 60,
    });

    const placed = await getTool(tools, 'place_task').handler({
      task_id: t.task.id,
      start: '2026-04-14T10:00:00Z',
    });

    // Event was recorded on the project's calendar
    expect(calendar.events).toHaveLength(1);
    const event = calendar.events[0];
    expect(event.calendar_id).toBe('cal-acme');
    expect(event.summary).toContain('Report');
    expect(event.start).toBe('2026-04-14T10:00:00Z');
    expect(event.end).toBe('2026-04-14T11:00:00.000Z');

    // Task got linked to the event
    expect(placed.task.calendar_event_id).toBe(event.id);
    expect(placed.task.status).toBe('SCHEDULED');
  });

  it('unplace_task deletes the calendar event and resets task status', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      calendar_id: 'cal-acme',
    });

    const calendar = new FakeCalendarClient();
    const tools = buildTools(db, { calendar });

    const t = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Report',
      duration_minutes: 60,
    });
    await getTool(tools, 'place_task').handler({
      task_id: t.task.id,
      start: '2026-04-14T10:00:00Z',
    });
    expect(calendar.events).toHaveLength(1);

    const result = await getTool(tools, 'unplace_task').handler({
      task_id: t.task.id,
    });

    expect(calendar.events).toHaveLength(0);
    expect(result.task.calendar_event_id).toBeNull();
    expect(result.task.status).toBe('NEW');
  });

  it('unplace_task is a no-op (no calendar call) when task was never placed', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const calendar = new FakeCalendarClient();
    const tools = buildTools(db, { calendar });

    const t = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'X',
    });

    // Should not throw, should not call deleteEvent
    await getTool(tools, 'unplace_task').handler({ task_id: t.task.id });
    expect(calendar.events).toHaveLength(0);
  });

  it('export_timesheet handler returns CSV string', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);
    const result = await getTool(tools, 'export_timesheet').handler({
      from: '2026-04-13',
      to: '2026-04-19',
    });
    expect(result.format).toBe('csv');
    expect(typeof result.csv).toBe('string');
    expect(result.csv).toContain('date,project,hours,task,notes');
  });

  it('export_timesheet with format=markdown returns markdown table', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);
    const result = await getTool(tools, 'export_timesheet').handler({
      from: '2026-04-13',
      to: '2026-04-19',
      format: 'markdown',
    });
    expect(result.format).toBe('markdown');
    expect(typeof result.markdown).toBe('string');
    expect(result.markdown).toContain('| date | project | hours | task | notes |');
  });

  it('export_timesheet with include_totals appends TOTAL row', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);
    const result = await getTool(tools, 'export_timesheet').handler({
      from: '2026-04-13',
      to: '2026-04-19',
      include_totals: true,
    });
    expect(result.csv).toContain(',TOTAL,0,,');
  });

  it('get_timesheet_summary returns structured data', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);
    const result = await getTool(tools, 'get_timesheet_summary').handler({
      from: '2026-04-13',
      to: '2026-04-19',
    });
    expect(result.summary).toBeDefined();
    expect(result.summary.rows).toEqual([]);
    expect(result.summary.by_project).toEqual([]);
    expect(result.summary.grand_total_hours).toBe(0);
  });

  it('rejects bad input on create_project (missing required field)', async () => {
    const db = freshDb();
    const tools = buildTools(db);
    const create = getTool(tools, 'create_project');
    await expect(
      create.handler({ id: 'acme' /* missing name + prefix */ }),
    ).rejects.toThrow();
  });
});
