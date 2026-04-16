---
name: week
description: Weekly planning session — calendar + JIRA + calendrome (budgets, tasks, timesheet)
---

# Weekly Planning Session

Run a start-of-week planning session. Fetch data from three sources
(Google Calendar, JIRA, calendrome), present a unified view with
budget status, help prioritize, create linked tasks + calendar events
for anything we block time for.

> **This is a template.** Copy to `~/.claude/skills/week.md` and
> replace every `<FILL IN: ...>` placeholder with your real values.
> See the repo README for the calendrome MCP setup.

## Shared Constants

- **Atlassian Cloud ID:** `<FILL IN: your Atlassian cloud id>`
- **Atlassian Account ID:** `<FILL IN: your Atlassian account id>`
- **Calendar timezone:** `<FILL IN: e.g. America/Chicago>`
- **Calendar ID:** `primary` (or a specific calendar id)
- **JIRA projects:** `<FILL IN: comma-separated project keys>`
- **Client prefixes / calendrome project ids:**
  - `ACME:` → calendrome `acme`
  - `GLBX:` → calendrome `glbx`
  - `HOBBY:` → calendrome `hobby`
  - *(substitute your real prefixes; these map 1:1 to calendrome `project.prefix` and `project.id`)*
- **Project repos** *(optional — for code task readiness checks)*:
  - `ACME:` `<FILL IN: local path to repo>`
- **Obsidian vault** *(optional)*: `<FILL IN: path>` — read for context, do not write
- **Personal email:** `<FILL IN: email>` — useful for task context

## Workflow

### Step 1: Fetch Data (run all three in parallel)

**Google Calendar — this week Mon–Fri:**
Use `gcal_list_events` with:
- `calendarId`: `primary`
- `timeMin`: this Monday at 00:00:00 in your timezone (ISO 8601 with offset)
- `timeMax`: this Friday at 23:59:59 in your timezone
- `timeZone`: as configured above

**JIRA — all open issues assigned to me:**
Use `searchJiraIssuesUsingJql` with:
- `cloudId`: your cloud id
- `jql`: `assignee = "<your account id>" AND status NOT IN (Done, Closed) ORDER BY priority DESC, updated DESC`
- Fields: `summary, status, priority, project, assignee, updated`

**Calendrome — budgets + current week's tasks:**
Use calendrome MCP tools:
- `get_all_budgets { week_start: "<Monday ISO date>" }` — returns allocated / spent / scheduled / remaining per project
- `list_tasks {}` — all NEW and SCHEDULED tasks (filter out COMPLETE/ARCHIVED client-side)

### Step 2: Present Unified Weekly View

Categorize calendar events into **meetings** (multi-person, standups,
syncs, reviews) vs **task blocks** (solo focus time, client-prefixed
work). Use event titles and attendee count to distinguish.

Format the output:

```
## Week of [date range]

### Budget Status (from calendrome)
| Project | Allocated | Spent | Scheduled | Remaining | Status |
|---------|----------:|------:|----------:|----------:|--------|
| ACME    | 20h       | 3h    | 8h        | 9h        | OK     |
| GLBX    | 10h       | 0h    | 12h       | -2h       | ⚠ over |
| HOBBY   | 5h        | 1h    | 0h        | 4h        | OK     |

### Meeting Load
| Day     | Meetings              | Hours |
|---------|-----------------------|-------|
| Monday  | Standup, ACME review  | 1.5h  |
| ...     | ...                   | ...   |

### Scheduled Task Blocks (calendar events with calendrome task link)
| Day     | Task                        | Hours | Calendrome task id |
|---------|-----------------------------|-------|--------------------|
| Monday  | ACME: Footer fix            | 2h    | #42                |
| ...     | ...                         | ...   | ...                |

### Open JIRA Tickets
#### [Project Key] — [Project Name]
| Key     | Summary             | Status      | Priority | In calendrome? |
|---------|---------------------|-------------|----------|----------------|
| ACME-42 | Fix login bug       | In Progress | High     | #12            |
| ACME-73 | Update docs         | To Do       | Medium   | —              |

### Gaps: Unplanned JIRA Tickets
These open JIRA tickets don't have calendar time blocked this week:
- [TICKET-XX] Summary (Priority)
- ...
```

### Step 3: Readiness Check

For each major task planned this week, assess whether we have what's
needed. Proactively gather context:

- **Code tasks:** Check for open PRs (`gh pr list` on the relevant
  repo), read JIRA ticket description/comments for requirements, note
  the working branch.
- **Personal tasks:** Search Gmail or Obsidian for context (last
  correspondence, reference docs, account info).
- **Blocked or unclear tasks:** Flag anything where the description
  is vague, dependencies are unresolved, or info is missing.

Present as:

```
### Readiness
- **ACME-42: Fix login bug** — PR open, requirements clear. ✓ Ready
- **ACME-73: Update docs** — No branch yet, acceptance criteria thin. ⚠ Needs clarification
- **M: File taxes** — FreeTaxUSA prepped, see Obsidian. ✓ Ready
```

### Step 4: Interactive Planning

After presenting the view, ask:

> "What would you like to prioritize this week? I can:
> - Block calendar time for unplanned JIRA tickets (I'll create both a
>   calendar event and a calendrome task so the time counts against
>   the project budget)
> - Adjust or move existing blocks (and keep calendrome in sync)
> - Flag tickets to defer or delegate
> - Dig deeper into any task that needs more context"

Wait for user input and act on their choices.

#### When the user wants to block time for a task, do a **3-step dance**:

Given: "block 2 hours for ACME-42 on Tuesday 9am"

1. **Create the calendrome task** (unless one already exists):
   ```
   calendrome create_task {
     project_id: "acme",
     title: "ACME-42: Fix login bug",
     priority: "HIGH",
     duration_minutes: 120
   }
   ```
   Capture the returned `task.id`.

2. **Create the Google Calendar event:**
   ```
   gcal create_event {
     calendarId: "primary",
     summary: "ACME Fix login bug",
     start: { dateTime: "2026-04-14T09:00:00-05:00", timeZone: "America/Chicago" },
     end:   { dateTime: "2026-04-14T11:00:00-05:00", timeZone: "America/Chicago" }
   }
   ```
   Capture the returned `event.id`.

3. **Link them** so calendrome knows the event exists and the
   budget query counts it:
   ```
   calendrome update_task {
     id: <task_id_from_step_1>,
     calendar_event_id: "<event_id_from_step_2>",
     due: "2026-04-14T09:00:00Z"
   }
   ```

After each placement, recompute the budget and show the updated
remaining hours so the user sees the impact immediately.

#### When removing a block:

Reverse the dance:
1. `gcal delete_event { eventId, calendarId }`
2. `calendrome update_task { id, calendar_event_id: null }`

(Or use `calendrome unplace_task { task_id }` if calendrome is
configured with a calendar client; most setups orchestrate via the
planner skill like above.)

### Step 5: End-of-Week Option — Timesheet Export

If this is a Friday session or the user asks about logging hours,
offer:

> "Want me to export the timesheet for this week? I can produce it as
> markdown (for pasting into a doc or ticket) or CSV (for uploading)."

Then call:
```
calendrome export_timesheet {
  from: "<Monday ISO date>",
  to: "<Friday ISO date>",
  format: "markdown",  // or "csv"
  include_totals: true
}
```

Present the output inline so they can copy.

### Gap Detection Logic

To find unplanned JIRA tickets, compare JIRA issue keys/summaries
against calendar event titles for the week. A JIRA ticket is
"unplanned" if no calendar event title contains the JIRA key (e.g.,
`ACME-42`) or a recognizable match of the summary text.

To find **calendrome tasks with no calendar event**, call
`list_tasks { status: "NEW" }` and filter for ones without a
`calendar_event_id`. Those are tasks you've captured but haven't
blocked time for yet.

### When to create calendrome projects

If a JIRA project appears in the week's issues but no matching
calendrome project exists, offer to create one:

```
calendrome create_project {
  id: "<lowercase prefix>",
  name: "<project name>",
  prefix: "<UPPERCASE prefix>",
  calendar_id: "<google calendar id or null for primary>",
  weekly_budget_minutes: <ask the user>
}
```

Projects are the unit of budget tracking — no project means no
budget visibility for that client's work.
