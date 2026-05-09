---
name: harvest-push
description: Push the user's calendrome timesheet to Harvest. Use when the user runs `/calendrome:harvest-push`, says "push my timesheet", "send hours to Harvest", "submit timesheet", "push the week to Harvest", or asks about logging Harvest hours from calendrome. Thin wrapper over the existing `mcp__calendrome__harvest_push_timesheet` MCP tool with date-range parsing and a dry-run preview.
argument-hint: "[range]  — 'today', 'week' (Mon–Fri), 'last-week', or two ISO dates"
allowed-tools: Read, Bash
---

# Harvest Push

Push calendrome time entries to Harvest as worklog rows. The actual work happens in `mcp__calendrome__harvest_push_timesheet`; this skill resolves the date range, previews what's about to be sent, and pushes only on user confirmation.

## Settings used

- `calendar_timezone` — used to resolve "today" / "week" boundaries
- `personal_email` — informational, surfaced in the confirmation block

If settings are missing, default to `America/Chicago` and proceed.

## Argument parsing

Resolve the requested range:

| Argument | Resolution |
|---|---|
| `today` (or no arg) | today 00:00 → today 23:59 in `<calendar_timezone>` |
| `week` | this Monday → this Friday |
| `last-week` | previous Monday → previous Friday |
| `<ISO from> <ISO to>` | use as-is |

If the user passes anything else, ask: "Push hours for: today, this week, last week, or a specific date range?"

## Workflow

### Step 1 — Preview

Call `mcp__calendrome__get_timesheet_summary { from, to }` first. Show the rows that would be pushed:

```
Timesheet preview — [from] to [to]

| Project | Date       | Hours | Notes |
|---------|------------|------:|-------|
| acme    | 2026-05-04 | 1.50  | Sprint planning |
| acme    | 2026-05-08 | 4.75  | Straight Arrow work |
| globex  | 2026-05-06 | 3.00  | Pipeline migration |

Total: 9.25h across 2 projects.

Push these to Harvest? (y/N)
```

### Step 2 — Verify Harvest mappings

Before pushing, confirm each project has Harvest IDs configured. Call `mcp__calendrome__list_projects {}` and check for `harvest_project_id` and `harvest_task_id` on each project that appears in the preview.

If any project is missing Harvest IDs, stop and tell the user:

```
Cannot push — these projects are not mapped to Harvest:
- globex (Globex Industries)

Set them with:
  mcp__calendrome__update_project { id: "globex", harvest_project_id: <id>, harvest_task_id: <id> }

Or run mcp__calendrome__harvest_list_projects {} to find the right IDs.
```

### Step 3 — Push

On confirmation, call:

```
mcp__calendrome__harvest_push_timesheet {
  from: "<ISO date>",
  to:   "<ISO date>"
}
```

Surface the result. Note any rows that failed (e.g., already-submitted Harvest entries that the API rejects).

### Step 4 — Confirm

```
Pushed N entries to Harvest.
Total: X.YYh
```

## Conventions

- **15-minute increments** — `harvest_push_timesheet` should already round, but if the preview shows odd durations (1.9h, 47-min entries), warn the user before pushing. See the user's `feedback_time_log_increments` preference.
- **Dry-run by default** — never push without showing the preview and getting explicit confirmation.
- **No retry on failure** — if Harvest returns errors, surface them and stop. Let the user decide whether to fix and retry.

## Edge cases

- No time entries in range → tell the user "Nothing to push for [range]" and exit.
- Harvest credentials missing (server returns auth error) → point at `HARVEST_TOKEN` / `HARVEST_ACCOUNT_ID` env vars on the calendrome MCP server.
- Project mapping changed mid-week → stop, ask user to confirm which mapping should win.
