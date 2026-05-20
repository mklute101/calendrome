---
name: week
description: Weekly planning session for calendrome — pulls Google Calendar, Jira, and calendrome budgets/tasks into one unified view, helps prioritize, and creates linked calendar events + calendrome tasks for blocked time. Use when the user runs `/calendrome:week`, says "plan the week", "let's do weekly planning", "what's on this week", or asks for a budget overview. Also handles end-of-week timesheet export on Friday sessions.
argument-hint: "(no args)"
allowed-tools: Read, Bash
---

# Weekly Planning Session

Start-of-week planning that unifies calendar + Jira + calendrome budgets, then helps the user commit time. Read settings from `.claude/calendrome.local.md` before doing anything.

## Settings used

- `atlassian_cloud_id`, `atlassian_account_id` — Jira queries
- `calendar_timezone`, `calendar_id` — calendar queries
- `jira_project_keys` — list of project keys to scan
- `project_prefixes` — `{prefix, project_id, name}` mapping (Jira key prefix → calendrome project)
- `project_repos` — optional `{prefix: filesystem_path}` for code readiness checks

If settings are missing, point the user to `/calendrome:onboard` and stop.

## Workflow

### Step 0 — Gather step: reconcile last week's drift

Before any new-week planning happens, surface anything from the prior
week that's still sitting unconfirmed. The user gets one sentence to
reconcile it; then we move on.

Call:

```
mcp__calendrome__list_pending_review {
  from: "<last Monday ISO date>",
  to:   "<this Monday ISO date>",
  category: "work"
}
```

(The range is the previous Mon–Sun, exclusive of this Monday.)

**If the result is empty:** brief acknowledgement and continue —

> "Last week is fully reconciled — moving on."

**If non-empty:** render the entries grouped by day, then ask for one
sentence:

```
### Unconfirmed from last week
**Tue 2026-05-06**
- 09:00–11:00 (120m) — ACME-42 Fix login bug [pending]
- 14:00–15:00 (60m)  — GLBX-7 Oak help [pending]

**Fri 2026-05-09**
- 10:00–12:00 (120m) — ACME-51 Refactor auth [pending]
- 13:00–14:00 (60m)  — GLBX-9 Standup notes [pending]
```

> "Any of last week need reconciling before we plan this week?"

Accept one freeform sentence and fan it out to the appropriate calls.
Typical phrasings:

- *"All good as-placed."* → `confirm_placement` for every entry, no
  amendments.
- *"Friday was a wash, skip everything."* → `skip_placement` for each
  Friday entry.
- *"Tuesday was actually all Oak help, log 8h on that."* → confirm or
  skip the Tuesday entries as appropriate, then
  `log_time { project_id: "glbx", started_at, stopped_at, notes }` for
  the 8h Oak block.
- *"ACME-42 was actually 90 minutes."* →
  `confirm_placement(<id>, { actual_minutes: 90 })`.

Tools you'll reach for here:

- `mcp__calendrome__confirm_placement(time_entry_id, { actual_minutes?, project_id?, notes? })`
- `mcp__calendrome__skip_placement(time_entry_id)`
- `mcp__calendrome__log_time({ task_id?, project_id?, started_at, stopped_at, notes? })`
- `mcp__calendrome__move_placement(time_entry_id, new_start_at, { new_end_at? })`

After the fan-out, confirm what was done in one line and proceed to
Step 1.

### Step 1 — Fetch data (parallel)

**Google Calendar** — this week Mon–Fri:
`mcp__claude_ai_Google_Calendar__list_events` with:
- `calendarId`: `<calendar_id>`
- `timeMin`: this Monday 00:00:00 in `<calendar_timezone>`
- `timeMax`: this Friday 23:59:59 in `<calendar_timezone>`
- `timeZone`: `<calendar_timezone>`

**Jira** — open assigned issues:
`mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql`:
- `cloudId`: `<atlassian_cloud_id>`
- `jql`: `assignee = "<atlassian_account_id>" AND status NOT IN (Done, Closed) ORDER BY priority DESC, updated DESC`
- `fields`: `["summary", "status", "priority", "project", "assignee", "updated"]`

If `jira_project_keys` is set, scope the JQL: `... AND project IN (<keys>)`.

**Calendrome** — budgets + tasks:
- `mcp__calendrome__get_all_budgets { week_start: "<Monday ISO date>" }`
- `mcp__calendrome__list_tasks {}` (filter to NEW and SCHEDULED client-side)

### Step 2 — Present unified view

Categorize calendar events into:
- **Meetings** — multi-person, standups, syncs, reviews
- **Task blocks** — solo focus time, prefix-tagged work
- **Personal** — workout, lunch, blocked personal time

Output:

```
## Week of [date range]

### Budget Status (calendrome)
| Project | Allocated | Spent | Scheduled | Remaining | Status |
|---------|----------:|------:|----------:|----------:|--------|
| ACME    | 20h       | 3h    | 8h        | 9h        | OK     |
| GLBX    | 10h       | 0h    | 12h       | -2h       | OVER   |

### Meeting Load
| Day | Meetings | Hours |

### Scheduled Task Blocks (calendar events with calendrome task link)
| Day | Task | Hours | Calendrome task id |

### Open JIRA Tickets
#### [Project Key] — [Project Name]
| Key | Summary | Status | Priority | In calendrome? |

### Gaps: Unplanned JIRA Tickets
- [TICKET-XX] Summary (Priority)
```

### Step 3 — Readiness check

For each major task this week, assess preparedness:
- **Code tasks** (prefix has `project_repos` entry) — `gh pr list`, read Jira description/comments, note working branch.
- **Personal tasks** — search Gmail or notes for context.
- **Blocked / unclear** — flag missing acceptance criteria, unresolved deps.

```
### Readiness
- **ACME-42** — PR open, requirements clear. Ready
- **ACME-73** — No branch yet, AC thin. Needs clarification
- **M: File taxes** — FreeTaxUSA prepped. Ready
```

### Step 4 — Interactive planning

After the view:

> "What would you like to prioritize this week? I can:
> - Block calendar time for unplanned Jira tickets (creates both the event and a calendrome task so it counts toward budget)
> - Adjust or move existing blocks (and keep calendrome in sync)
> - Flag tickets to defer or delegate
> - Dig deeper into any task that needs more context"

#### When the user blocks time, place through calendrome

Calendrome owns placement — **never** call `mcp__claude_ai_Google_Calendar__create_event` directly. The calendar event is synced from calendrome's placement.

Given: "block 2 hours for ACME-42 on Tuesday 9am"

1. **Find or create the calendrome task** (skip create if it exists):
```
mcp__calendrome__create_task {
  project_id: "<resolved from project_prefixes>",
  title: "ACME-42: Fix login bug",
  priority: "HIGH",
  duration_minutes: 120
}
```
Capture the returned `task.id`.

2. **Place it** at the requested start time:
```
mcp__calendrome__place_task {
  task_id: <task_id>,
  start: "<Tuesday 09:00 ISO with calendar_timezone offset>"
}
```
This creates the calendar placement and a paired UNCONFIRMED `time_entry` sized to the task's duration. The GCal event is synced from calendrome.

After each placement, recompute the budget and show the updated remaining hours so the user sees the impact immediately.

#### Removing a block

`mcp__calendrome__unplace_task { task_id }` — calendrome owns the lifecycle, including removing the synced GCal event. Do not call `mcp__claude_ai_Google_Calendar__delete_event` directly.

### Step 5 — End-of-week timesheet (Friday or on request)

If the session is Friday or the user asks about hours:

> "Want me to export the timesheet for this week? Markdown for pasting, CSV for upload."

Then:
```
mcp__calendrome__export_timesheet {
  from: "<Monday ISO>",
  to: "<Friday ISO>",
  format: "markdown" | "csv",
  include_totals: true
}
```

Present inline.

## Detection helpers

### Gap detection

To find unplanned Jira tickets, compare Jira keys/summaries against calendar event titles for the week. A ticket is "unplanned" if no event title contains the key (e.g., `ACME-42`) or a recognizable substring of the summary.

To find calendrome tasks with no calendar event: `mcp__calendrome__list_tasks { status: "NEW" }` and filter where `calendar_event_id` is null.

### Project auto-creation

If a Jira project appears in the week's issues but has no matching calendrome project, offer:

```
mcp__calendrome__create_project {
  id: "<lowercase prefix>",
  name: "<project name>",
  prefix: "<UPPERCASE prefix>",
  weekly_budget_minutes: <ask user>,
  category_id: "work"
}
```

Then append a row to `project_prefixes` in the settings file.

Projects are the unit of budget tracking — no project means no budget visibility for that work.
