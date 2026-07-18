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
      'complete_task',
      'inbox_add',
      'inbox_list',
      'inbox_next',
      'inbox_process',
      'create_habit',
      'list_habits',
      'generate_habit_instances',
      'create_goal',
      'list_goals',
      'update_goal',
      'deactivate_goal',
      'place_goal_block',
      'assign_hours',
      'pull_hours',
      'list_envelope_moves',
      'get_envelopes',
      'get_supply',
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
      'delete_time_entry',
      'sync_calendar_events',
      'add_meeting_project_mapping',
      'list_meeting_project_mappings',
      'delete_meeting_project_mapping',
      'list_categories',
      'create_category',
      'update_category',
      'block_time',
      'open_time',
      'list_availability',
      'delete_availability',
      'clear_availability',
      'gui_start',
      'gui_stop',
      'gui_status',
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

  it('complete_task handler marks the task COMPLETE', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);

    const created = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'X',
    });
    const id = created.task.id;

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

    // Task got linked to the event via the paired placement time_entry
    // (external_id = event.id). `task.calendar_event_id` is no longer
    // stamped — the time_entry is the canonical link.
    expect(placed.task.status).toBe('SCHEDULED');

    // A paired UNCONFIRMED time_entry was inserted (source='placement',
    // external_id=event.id). This is the row the confirmation flow
    // operates on.
    const rows = db
      .prepare(`SELECT * FROM time_entry WHERE external_id = ?`)
      .all(event.id) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('UNCONFIRMED');
    expect(rows[0].source).toBe('placement');
    expect(rows[0].task_id).toBe(t.task.id);
    expect(rows[0].project_id).toBe('acme');
    expect(rows[0].start_at).toBe('2026-04-14T10:00:00Z');
    expect(rows[0].end_at).toBe('2026-04-14T11:00:00Z');
    expect(placed.time_entry_id).toBe(rows[0].id);
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
    expect(result.task.status).toBe('NEW');

    // Paired placement time_entry was also deleted
    const rows = db
      .prepare(`SELECT id FROM time_entry WHERE task_id = ?`)
      .all(t.task.id) as any[];
    expect(rows).toHaveLength(0);
  });

  it('unplace_task throws when the paired time_entry is already CONFIRMED', async () => {
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

    // Flip the paired time_entry to CONFIRMED to simulate a confirmed
    // placement.
    await getTool(tools, 'confirm_placement').handler({
      time_entry_id: placed.time_entry_id,
    });

    await expect(
      getTool(tools, 'unplace_task').handler({ task_id: t.task.id }),
    ).rejects.toThrow(/CONFIRMED/);

    // Calendar event was NOT deleted because the throw happened first
    expect(calendar.events).toHaveLength(1);
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
    // due is a pure deadline field — placement must not write it (#79)
    expect(placed.task.due).toBeNull();
    // The paired placement time_entry holds the calendar event id
    // (external_id), which LocalCalendarClient mints as `local-<uuid>`.
    expect(placed.event.id).toMatch(/^local-[0-9a-f-]{36}$/);
    const paired = db
      .prepare(
        `SELECT external_id FROM time_entry
         WHERE task_id = ? AND source = 'placement'`,
      )
      .get(t.task.id) as { external_id: string };
    expect(paired.external_id).toBe(placed.event.id);

    // unplace_task must not throw against LocalCalendarClient's no-op delete
    const cleared = await getTool(tools, 'unplace_task').handler({
      task_id: t.task.id,
    });
    expect(cleared.task.status).toBe('NEW');
    // And the paired time_entry is gone
    const remaining = db
      .prepare(`SELECT id FROM time_entry WHERE task_id = ?`)
      .all(t.task.id) as any[];
    expect(remaining).toHaveLength(0);
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

  it('log_time handler inserts a CONFIRMED time_entry and returns the task', async () => {
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
    expect(result.entry.task_id).toBe(t.task.id);
    expect(result.entry.project_id).toBe('acme');
    // log_time leaves status alone — user calls complete_task separately
    expect(result.task.status).toBe('NEW');

    // Persisted as a CONFIRMED manual time_entry row
    const row = db
      .prepare('SELECT status, source, actual_minutes FROM time_entry WHERE id = ?')
      .get(result.entry.id) as { status: string; source: string; actual_minutes: number };
    expect(row.status).toBe('CONFIRMED');
    expect(row.source).toBe('manual');
    expect(row.actual_minutes).toBe(180);
  });

  it('delete_time_entry handler deletes a logged entry and returns its row', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);

    const t = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Misattributed work',
    });
    const logged = await getTool(tools, 'log_time').handler({
      task_id: t.task.id,
      started_at: '2026-05-04T09:00:00Z',
      stopped_at: '2026-05-04T10:00:00Z',
    });

    const result = await getTool(tools, 'delete_time_entry').handler({
      id: logged.entry.id,
    });
    expect(result.deleted).toBe(true);
    expect(result.entry.id).toBe(logged.entry.id);

    const row = db
      .prepare('SELECT id FROM time_entry WHERE id = ?')
      .get(logged.entry.id);
    expect(row).toBeUndefined();
  });

  it('delete_time_entry refuses Harvest-pushed entries without force', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db);

    const t = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Already pushed',
    });
    const logged = await getTool(tools, 'log_time').handler({
      task_id: t.task.id,
      started_at: '2026-05-04T09:00:00Z',
      stopped_at: '2026-05-04T10:00:00Z',
    });
    db.prepare('UPDATE time_entry SET harvest_entry_id = ? WHERE id = ?')
      .run(12345, logged.entry.id);

    await expect(
      getTool(tools, 'delete_time_entry').handler({ id: logged.entry.id }),
    ).rejects.toThrow(/Harvest/i);

    const result = await getTool(tools, 'delete_time_entry').handler({
      id: logged.entry.id,
      force: true,
    });
    expect(result.deleted).toBe(true);
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

  it('get_week_layout positions tasks by placement time_entry, not task.due (#79)', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const tools = buildTools(db, { calendar: new FakeCalendarClient() });

    const placedTask = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Placed this week',
      duration_minutes: 60,
    });
    const placed = await getTool(tools, 'place_task').handler({
      task_id: placedTask.task.id,
      start: '2026-06-16T10:00:00Z',
    });
    // Deadline inside the week but never placed — must not show up as
    // "on the calendar".
    await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Deadline only',
      duration_minutes: 60,
      due: '2026-06-17T17:00:00Z',
    });
    // Placed outside the requested range.
    const nextWeek = await getTool(tools, 'create_task').handler({
      project_id: 'acme',
      title: 'Placed next week',
      duration_minutes: 60,
    });
    await getTool(tools, 'place_task').handler({
      task_id: nextWeek.task.id,
      start: '2026-06-23T10:00:00Z',
    });

    const layout = await getTool(tools, 'get_week_layout').handler({
      from: '2026-06-15',
      to: '2026-06-21',
    });
    const titles = layout.tasks.map((t: any) => t.title);
    expect(titles).toEqual(['Placed this week']);
    expect(layout.placements).toHaveLength(1);
    expect(layout.placements[0]).toMatchObject({
      time_entry_id: placed.time_entry_id,
      task_id: placedTask.task.id,
      start_at: '2026-06-16T10:00:00Z',
      status: 'UNCONFIRMED',
    });
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

describe('commitments prototype tools (#106)', () => {
  // 2026-07-13 is a Monday.
  const WEEK = '2026-07-13';

  async function setupTools() {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      weekly_budget_minutes: 1200,
    });
    createProject(db, { id: 'personal', name: 'Personal', prefix: 'PERS' });
    return buildTools(db);
  }

  it('create_goal → list_goals embeds progress for the week', async () => {
    const tools = await setupTools();
    const { goal } = await getTool(tools, 'create_goal').handler({
      project_id: 'personal',
      title: 'Spanish practice',
      target_minutes: 180,
      refill_period: 'week',
    });
    expect(goal.id).toBeGreaterThan(0);

    const listed = await getTool(tools, 'list_goals').handler({
      week_start: WEEK,
    });
    expect(listed.week_start).toBe(WEEK);
    expect(listed.goals).toHaveLength(1);
    expect(listed.goals[0].progress.weekly_ask).toBe(180);
    expect(listed.goals[0].progress.status).toBe('on_track');
  });

  it('place_goal_block schedules an UNCONFIRMED entry against the goal', async () => {
    const tools = await setupTools();
    const { goal } = await getTool(tools, 'create_goal').handler({
      project_id: 'personal',
      title: 'Spanish practice',
      target_minutes: 180,
      refill_period: 'week',
    });
    const { entry } = await getTool(tools, 'place_goal_block').handler({
      goal_id: goal.id,
      start: '2026-07-14T18:00:00Z',
      duration_minutes: 60,
    });
    expect(entry.goal_id).toBe(goal.id);
    expect(entry.project_id).toBe('personal');
    expect(entry.status).toBe('UNCONFIRMED');
    expect(entry.source).toBe('placement');
    expect(entry.end_at).toBe('2026-07-14T19:00:00Z');

    const listed = await getTool(tools, 'list_goals').handler({
      week_start: WEEK,
    });
    expect(listed.goals[0].progress.week_scheduled).toBe(60);

    await expect(
      getTool(tools, 'place_goal_block').handler({
        goal_id: 999,
        start: '2026-07-14T18:00:00Z',
        duration_minutes: 60,
      }),
    ).rejects.toThrow(/goal 999 not found/);
  });

  it('assign_hours / pull_hours / list_envelope_moves / get_envelopes round-trip', async () => {
    const tools = await setupTools();
    await getTool(tools, 'assign_hours').handler({
      envelope_type: 'project',
      envelope_id: 'personal',
      week_start: WEEK,
      minutes: 300,
    });
    const { move } = await getTool(tools, 'pull_hours').handler({
      week_start: WEEK,
      from: { type: 'project', id: 'personal' },
      to: { type: 'project', id: 'acme' },
      minutes: 120,
      note: 'launch crunch',
    });
    expect(move.minutes).toBe(120);

    const { moves } = await getTool(tools, 'list_envelope_moves').handler({
      week_start: WEEK,
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].note).toBe('launch crunch');

    const { envelopes } = await getTool(tools, 'get_envelopes').handler({
      week_start: WEEK,
    });
    const acme = envelopes.find((r: any) => r.envelope_id === 'acme');
    const personal = envelopes.find((r: any) => r.envelope_id === 'personal');
    expect(acme.assigned).toBe(1320);
    expect(personal.assigned).toBe(180);
    for (const row of envelopes) {
      expect(row).toHaveProperty('title');
      expect(row).toHaveProperty('activity.confirmed_minutes');
      expect(row).toHaveProperty('activity.scheduled_minutes');
      expect(row).toHaveProperty('available');
      expect(row).toHaveProperty('funding');
      expect(row).toHaveProperty('status_line');
    }
  });

  it('update_goal and deactivate_goal handlers work', async () => {
    const tools = await setupTools();
    const { goal } = await getTool(tools, 'create_goal').handler({
      project_id: 'acme',
      title: 'Prospecting',
      target_minutes: 600,
      due: '2026-08-10',
    });
    const updated = await getTool(tools, 'update_goal').handler({
      id: goal.id,
      target_minutes: 720,
    });
    expect(updated.goal.target_minutes).toBe(720);

    await getTool(tools, 'deactivate_goal').handler({ id: goal.id });
    const listed = await getTool(tools, 'list_goals').handler({
      active: true,
      week_start: WEEK,
    });
    expect(listed.goals).toHaveLength(0);
  });

  it('create_habit accepts times_per_week', async () => {
    const tools = await setupTools();
    const { habit } = await getTool(tools, 'create_habit').handler({
      project_id: 'personal',
      title: 'Workout',
      duration_minutes: 45,
      times_per_week: 4,
      start_time: '17:30',
    });
    expect(habit.times_per_week).toBe(4);
    expect(habit.days_of_week).toBe('');
  });
});
