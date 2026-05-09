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

#### When the user blocks time, do the 3-step dance

Given: "block 2 hours for ACME-42 on Tuesday 9am"

1. **Create the calendrome task** (skip if it exists):
```
mcp__calendrome__create_task {
  project_id: "<resolved from project_prefixes>",
  title: "ACME-42: Fix login bug",
  priority: "HIGH",
  duration_minutes: 120
}
```
Capture the returned `task.id`.

2. **Create the calendar event**:
```
mcp__claude_ai_Google_Calendar__create_event {
  calendarId: "<calendar_id>",
  summary: "ACME Fix login bug",
  start: { dateTime: "...", timeZone: "<calendar_timezone>" },
  end:   { dateTime: "...", timeZone: "<calendar_timezone>" }
}
```
Capture the returned `event.id`.

3. **Link them**:
```
mcp__calendrome__update_task {
  id: <task_id>,
  calendar_event_id: "<event_id>",
  due: "<event start ISO>"
}
```

After each placement, recompute the budget and show the updated remaining hours so the user sees the impact immediately.

#### Removing a block (reverse the dance)

1. `mcp__claude_ai_Google_Calendar__delete_event`
2. `mcp__calendrome__update_task { id, calendar_event_id: null }`

Or use `mcp__calendrome__unplace_task { task_id }` if the calendrome calendar client is configured.

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
