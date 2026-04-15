import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { buildTools } from '../src/mcp/tools/index.js';

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
      id: 'san',
      name: 'SAN',
      prefix: 'SAN',
      weekly_budget_minutes: 1200,
    });
    expect(result.project.id).toBe('san');
    expect(result.project.weekly_budget_minutes).toBe(1200);
  });

  it('create_task handler creates a task within a project', async () => {
    const db = freshDb();
    createProject(db, { id: 'san', name: 'SAN', prefix: 'SAN' });
    const tools = buildTools(db);
    const create = getTool(tools, 'create_task');
    const result = await create.handler({ project_id: 'san', title: 'X' });
    expect(result.task.title).toBe('X');
    expect(result.task.project_id).toBe('san');
  });

  it('start_task / stop_task / complete_task handlers work end-to-end', async () => {
    const db = freshDb();
    createProject(db, { id: 'san', name: 'SAN', prefix: 'SAN' });
    const tools = buildTools(db);

    const created = await getTool(tools, 'create_task').handler({
      project_id: 'san',
      title: 'X',
    });
    const id = created.task.id;

    await getTool(tools, 'start_task').handler({ id });
    await getTool(tools, 'stop_task').handler({ id });
    const done = await getTool(tools, 'complete_task').handler({ id });
    expect(done.task.status).toBe('COMPLETE');
  });

  it('place_task uses the calendar client adapter (mocked)', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'san',
      name: 'SAN',
      prefix: 'SAN',
      calendar_id: 'cal-san',
    });

    let captured: any = null;
    const fakeCal = {
      createEvent: async (args: any) => {
        captured = args;
        return { id: 'evt-123' };
      },
      deleteEvent: async () => {},
    };

    const tools = buildTools(db, { calendar: fakeCal });
    const create = getTool(tools, 'create_task');
    const t = await create.handler({
      project_id: 'san',
      title: 'Op-ed',
      duration_minutes: 60,
    });

    const place = getTool(tools, 'place_task');
    const placed = await place.handler({
      task_id: t.task.id,
      start: '2026-04-14T10:00:00Z',
    });
    expect(captured.calendar_id).toBe('cal-san');
    expect(captured.summary).toContain('Op-ed');
    expect(placed.task.calendar_event_id).toBe('evt-123');
    expect(placed.task.status).toBe('SCHEDULED');
  });

  it('export_timesheet handler returns CSV string', async () => {
    const db = freshDb();
    createProject(db, { id: 'san', name: 'SAN', prefix: 'SAN' });
    const tools = buildTools(db);
    const result = await getTool(tools, 'export_timesheet').handler({
      from: '2026-04-13',
      to: '2026-04-19',
    });
    expect(typeof result.csv).toBe('string');
    expect(result.csv).toContain('date,project,hours,task,notes');
  });

  it('rejects bad input on create_project (missing required field)', async () => {
    const db = freshDb();
    const tools = buildTools(db);
    const create = getTool(tools, 'create_project');
    await expect(
      create.handler({ id: 'san' /* missing name + prefix */ }),
    ).rejects.toThrow();
  });
});
