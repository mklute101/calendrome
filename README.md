# Calendrome

A local, project-based task scheduling engine exposed as an MCP server.
Designed to replace Reclaim.ai with a simpler model: **you** (via Claude
planner skills) decide what goes where, calendrome tracks the tasks,
budgets, habits, and time.

## Quick start

```bash
npm install
npm run build
npm test          # 110+ tests, all should pass
```

## Run as an MCP server

```bash
# Default DB path: ./calendrome.db (created on first run)
npm start

# Or specify a custom DB path:
CALENDROME_DB=~/my-tasks.db npm start
```

The server uses stdio transport — it reads JSON-RPC from stdin and
writes to stdout. This is the standard MCP protocol.

## Add to Claude Code

In your Claude Code settings (`~/.claude/settings.json` or project-level
`.claude/settings.json`), add:

```json
{
  "mcpServers": {
    "calendrome": {
      "command": "node",
      "args": ["/path/to/calendrome/dist/src/mcp/server.js"],
      "env": {
        "CALENDROME_DB": "/path/to/calendrome.db"
      }
    }
  }
}
```

Restart Claude Code. You should see calendrome tools in your tool list.

## Demo: weekly planning flow

With both **calendrome** and **Google Calendar** MCP servers connected,
plus a **Jira** MCP:

1. **Set up projects** (one-time):
   ```
   create_project { id: "acme", name: "Acme Corp", prefix: "ACME", weekly_budget_minutes: 1200 }
   ```

2. **Pull Jira tickets → create tasks**:
   ```
   create_task { project_id: "acme", title: "ACME-123: Fix login bug", priority: "HIGH", duration_minutes: 120 }
   ```

3. **Check budgets**:
   ```
   get_all_budgets { week_start: "2026-04-13" }
   → ACME: 0h spent / 20h allocated
   ```

4. **Place on calendar** (via Google Calendar MCP):
   ```
   # Create the calendar event
   create_event { summary: "ACME Fix login bug", start: "2026-04-14T09:00:00", end: "2026-04-14T11:00:00", calendarId: "primary" }

   # Link the event to the task
   update_task { id: 1, calendar_event_id: "evt-abc123" }
   ```

5. **Track time** (when you start working):
   ```
   start_task { id: 1 }
   ... work ...
   stop_task { id: 1 }
   ```

6. **Export timesheet**:
   ```
   export_timesheet { from: "2026-04-13", to: "2026-04-19", format: "markdown" }
   ```

## Available MCP tools

### Projects
- `create_project` — create a project with prefix and weekly budget. `category_id` defaults to `work`.
- `list_projects` — list projects (filter by `active`, by `category_id` for the work/personal split)
- `update_project` — update project settings (including `category_id`)

### Categories & availability
Every project belongs to a category (`work`, `personal`, …) that owns a default
scheduling window. The GUI defaults to the work view so casual screen-shares
never leak personal stuff. Availability overrides are the frictionless answer
to "Tuesday night I'm not doing anything" — one MCP call from a single
sentence to Claude.

- `list_categories` — all categories with their default windows
- `create_category` — define a new category with a window
- `update_category` — change the window or rename
- `block_time` — reserve a slot so the planner won't schedule into it
- `open_time` — carve out an extra slot inside a normally-blocked window
- `list_availability` — overrides intersecting a date range
- `delete_availability` / `clear_availability` — remove individually or by range

### Tasks
- `create_task` — create a task in a project
- `update_task` — update task fields
- `list_tasks` — list with filters (project, status, due_before)
- `search_tasks` — full-text search titles and notes
- `start_task` — start the timer
- `stop_task` — stop the timer
- `complete_task` — mark done

### Inbox
- `inbox_add` — quick capture
- `inbox_list` — unprocessed items
- `inbox_next` — oldest unprocessed
- `inbox_process` — convert to task in a project

### Habits
- `create_habit` — recurring time block
- `list_habits` — active habits
- `generate_habit_instances` — materialize instances for a date range

### Budgets
- `get_project_budget` — allocated/spent/scheduled/remaining for one project
- `get_all_budgets` — same, for every active project

### Calendar placement
- `place_task` — create a calendar event for a task (requires calendar client)
- `unplace_task` — remove the calendar event

### Timesheet
- `export_timesheet` — CSV or markdown, with optional totals
- `get_timesheet_summary` — structured data for programmatic consumers

### Layout
- `get_week_layout` — tasks + habits + events for a date range, by day
