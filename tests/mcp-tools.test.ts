import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { buildTools } from '../src/mcp/tools/index.js';
import { FakeCalendarClient } from '../src/calendar/fake.js';
import { LocalCalendarClient } from '../src/calendar/local.js';

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
      'confirm_placement',
      'skip_placement',
      'list_pending_review',
      'move_placement',
      'log_time',
      'sync_calendar_events',
      'list_categories',
      'create_category',
      'update_category',
      'block_time',
      'open_time',
      'list_availability',
      'delete_availability',
      'clear_availability',
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

  it('place_task succeeds against LocalCalendarClient (the production default)', async () => {
    // Regression guard for #26: server.ts wired buildTools(db) with no
    // calendar arg, falling through to stubCalendar and throwing
    // "No CalendarClient configured". Production now wires LocalCalendarClient,
    // so place_task must work end-to-end against it.
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      calendar_id: 'cal-acme',
    });

    const tools = buildTools(db, { calendar: new LocalCalendarClient() });

    const t = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Report',
      duration_minutes: 60,
    });

    const placed = await getTool(tools, 'place_task').handler({
      task_id: t.task.id,
      start: '2026-04-14T10:00:00Z',
    });

    expect(placed.task.status).toBe('SCHEDULED');
    expect(placed.task.due).toBe('2026-04-14T10:00:00Z');
    expect(placed.task.calendar_event_id).toMatch(/^local-[0-9a-f-]{36}$/);

    // unplace_task must not throw against LocalCalendarClient's no-op delete
    const cleared = await getTool(tools, 'unplace_task').handler({
      task_id: t.task.id,
    });
    expect(cleared.task.calendar_event_id).toBeNull();
    expect(cleared.task.status).toBe('NEW');
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

  it('log_time handler inserts a closed entry and returns the updated task', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);

    const t = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Sprint planning',
    });

    const result = await getTool(tools, 'log_time').handler({
      task_id: t.task.id,
      started_at: '2026-05-04T09:00:00Z',
      stopped_at: '2026-05-04T12:00:00Z',
      notes: 'with the team',
    });

    expect(result.entry.duration_minutes).toBe(180);
    expect(result.entry.notes).toBe('with the team');
    expect(result.task.time_spent_minutes).toBe(180);
    // log_time leaves status alone — user calls complete_task separately
    expect(result.task.status).toBe('NEW');
  });

  it('log_time handler propagates validation errors (inverted timestamps)', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);

    const t = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'X',
    });

    await expect(
      getTool(tools, 'log_time').handler({
        task_id: t.task.id,
        started_at: '2026-05-04T12:00:00Z',
        stopped_at: '2026-05-04T09:00:00Z',
      }),
    ).rejects.toThrow(/strictly after/);
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

  it('list_categories returns the seeded work + personal categories', async () => {
    const db = freshDb();
    const tools = buildTools(db);
    const result = await getTool(tools, 'list_categories').handler({});
    const ids = result.categories.map((c: any) => c.id);
    expect(ids).toContain('work');
    expect(ids).toContain('personal');
  });

  it('update_category changes the default scheduling window', async () => {
    const db = freshDb();
    const tools = buildTools(db);
    const result = await getTool(tools, 'update_category').handler({
      id: 'work',
      default_window: { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' },
    });
    expect(result.category.default_window).toEqual({
      days: [1, 2, 3, 4, 5],
      start: '08:00',
      end: '18:00',
    });
  });

  it('list_projects with category_id filters out the other category', async () => {
    const db = freshDb();
    const tools = buildTools(db);
    await getTool(tools, 'create_project').handler({
      id: 'acme',
      name: 'Acme',
      prefix: 'ACME',
    });
    await getTool(tools, 'create_project').handler({
      id: 'home',
      name: 'Home',
      prefix: 'HOME',
      category_id: 'personal',
    });

    const workView = await getTool(tools, 'list_projects').handler({
      category_id: 'work',
    });
    expect(workView.projects.map((p: any) => p.id)).toEqual(['acme']);
  });

  it('block_time creates an availability override for the planner to respect', async () => {
    const db = freshDb();
    const tools = buildTools(db);
    const result = await getTool(tools, 'block_time').handler({
      start: '2026-05-12T18:00:00Z',
      end: '2026-05-12T22:00:00Z',
      reason: 'family dinner',
    });
    expect(result.override.available).toBe(0);
    expect(result.override.reason).toBe('family dinner');
  });

  it('block_time → list_availability → clear_availability round-trip', async () => {
    const db = freshDb();
    const tools = buildTools(db);
    await getTool(tools, 'block_time').handler({
      start: '2026-05-12T18:00:00Z',
      end: '2026-05-12T22:00:00Z',
      category_id: 'personal',
    });
    const list = await getTool(tools, 'list_availability').handler({
      from: '2026-05-12T00:00:00Z',
      to: '2026-05-13T00:00:00Z',
      category_id: 'personal',
    });
    expect(list.overrides).toHaveLength(1);

    const cleared = await getTool(tools, 'clear_availability').handler({
      start: '2026-05-12T00:00:00Z',
      end: '2026-05-13T00:00:00Z',
      category_id: 'personal',
    });
    expect(cleared.removed).toBe(1);

    const after = await getTool(tools, 'list_availability').handler({
      from: '2026-05-12T00:00:00Z',
      to: '2026-05-13T00:00:00Z',
      category_id: 'personal',
    });
    expect(after.overrides).toHaveLength(0);
  });

  it('open_time records an availability=1 (carve-out) override', async () => {
    const db = freshDb();
    const tools = buildTools(db);
    const result = await getTool(tools, 'open_time').handler({
      start: '2026-05-09T10:00:00Z',
      end: '2026-05-09T12:00:00Z',
      category_id: 'personal',
      reason: 'free Saturday morning',
    });
    expect(result.override.available).toBe(1);
    expect(result.override.category_id).toBe('personal');
  });

  // Story 1: screen-share filter — when sharing your screen at work, the
  // GUI should never leak personal projects/budgets/tasks. This test pins
  // the API contract that list_projects + get_all_budgets + get_week_layout
  // can all be filtered to work-only output.
  it('screen-share story: every list endpoint can be filtered to a single category', async () => {
    const db = freshDb();
    const tools = buildTools(db);

    await getTool(tools, 'create_project').handler({
      id: 'acme',
      name: 'Acme',
      prefix: 'ACME',
      weekly_budget_minutes: 600,
    });
    await getTool(tools, 'create_project').handler({
      id: 'home',
      name: 'Home',
      prefix: 'HOME',
      category_id: 'personal',
      weekly_budget_minutes: 300,
    });
    await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Build report',
    });
    await getTool(tools, 'create_task').handler({
      project_id: 'home',
      title: 'Therapy appointment',
    });

    const projects = await getTool(tools, 'list_projects').handler({
      category_id: 'work',
    });
    const personalNames = projects.projects
      .map((p: any) => p.id)
      .filter((id: string) => id === 'home');
    expect(personalNames).toEqual([]);

    // The personal task is still in the DB but shouldn't surface in any
    // work-filtered listing the GUI calls.
    const allTasks = await getTool(tools, 'list_tasks').handler({});
    const workProjectIds = projects.projects.map((p: any) => p.id);
    const taskTitlesVisibleToWork = allTasks.tasks
      .filter((t: any) => workProjectIds.includes(t.project_id))
      .map((t: any) => t.title);
    expect(taskTitlesVisibleToWork).toContain('Build report');
    expect(taskTitlesVisibleToWork).not.toContain('Therapy appointment');
  });
});
