---
name: calendrome
description: Calendrome help — show status, available commands, and setup guide
---

# Calendrome — Status & Help

This skill is the entry point for calendrome. It checks current state
and shows the user what they can do.

## Instructions

When invoked, perform these steps:

### 1. Check State

Call these calendrome MCP tools in parallel:

- `list_projects {}` — get all configured projects
- `get_all_budgets { week_start: "<this Monday's ISO date>" }` — budget overview for the current week

Also call `list_tasks {}` to get a count of active tasks (status NEW or SCHEDULED).

### 2. Decide Output Path

- **If no projects exist** → show the First-Time Setup guide (Section A)
- **If projects exist** → show the Status Dashboard (Section B)

---

## Section A: First-Time Setup

If `list_projects` returns an empty array, present:

```
## Welcome to Calendrome!

You don't have any projects set up yet. Let's get started.

### Quick Setup

1. **Create your first project** (a project = a client or area of work with a weekly hour budget):

   I'll call `create_project` for you. Tell me:
   - **id** — short lowercase slug (e.g. `acme`)
   - **name** — display name (e.g. "Acme Corp")
   - **prefix** — uppercase prefix for task titles (e.g. `ACME`)
   - **weekly_budget_minutes** — how many minutes per week to allocate (e.g. 1200 = 20h)

2. **Create tasks** inside that project:

   `create_task { project_id: "acme", title: "Fix login page", priority: "HIGH", duration_minutes: 120 }`

3. **Run the weekly planner** to block calendar time for tasks:

   Type `/week` to start a planning session.

### Optional: Harvest Integration

To push timesheets to Harvest, set these environment variables:
- `HARVEST_TOKEN` — your Harvest personal access token
- `HARVEST_ACCOUNT_ID` — your Harvest account ID

Then map each calendrome project to Harvest by setting `harvest_project_id` and
`harvest_task_id` on the project via `update_project`.

### GUI

Run `npm run gui` to open the visual timeline at http://localhost:3737.
```

---

## Section B: Status Dashboard

If projects exist, format and present:

```
## Calendrome Status

### Projects (<N> configured)
| Project | Budget (weekly) | Spent | Scheduled | Remaining | Status |
|---------|----------------:|------:|----------:|----------:|--------|
| ...     | ...             | ...   | ...       | ...       | ...    |

(Populate from `get_all_budgets` response. Show "OK" if remaining >= 0, "OVER" if negative.)

### Tasks
- **Active tasks:** <count of NEW + SCHEDULED tasks>
- **In progress:** <count of tasks with active time entries, if available>

### Available Commands

| Command / Action | What it does |
|------------------|--------------|
| `/week` | Run the weekly planning session — fetch calendar, tasks, budgets and plan the week |
| Create a project | `create_project { id, name, prefix, weekly_budget_minutes }` |
| Create a task | `create_task { project_id, title, priority, duration_minutes }` |
| Start/stop a task | `start_task { task_id }` / `stop_task { task_id }` — tracks time |
| Complete a task | `complete_task { task_id }` |
| Check budgets | `get_all_budgets { week_start }` or `get_project_budget { project_id, week_start }` |
| Export timesheet | `export_timesheet { from, to, format: "csv" | "markdown" }` |
| Push to Harvest | `harvest_push_timesheet { from, to }` (requires Harvest env vars) |
| Open GUI | Run `npm run gui` → http://localhost:3737 |
| Inbox | `inbox_add { text }` / `inbox_list` / `inbox_process` — quick capture |
| Habits | `create_habit` / `list_habits` / `generate_habit_instances` |
| Search tasks | `search_tasks { query }` |

### Harvest Status
```

Check whether Harvest env vars are likely configured by looking at the
project data — if any project has `harvest_project_id` set, note:
"Harvest integration: **configured** for <project names>."

If no projects have Harvest mappings, note:
"Harvest integration: **not configured**. Set `HARVEST_TOKEN` and `HARVEST_ACCOUNT_ID` env vars, then map projects with `update_project { id, harvest_project_id, harvest_task_id }`."

---

## Formatting Notes

- Use a clean, scannable layout. Tables for budgets, bullet lists for actions.
- All dates should use the user's current week (Monday to Sunday).
- Keep the output concise — this is a dashboard, not a tutorial.
- If any MCP call fails (e.g. server not running), tell the user:
  "Could not reach the calendrome MCP server. Make sure it's running (`npm run dev` or check your MCP config)."
