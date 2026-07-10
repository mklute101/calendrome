---
name: week
description: Weekly planning session for calendrome — pulls Google Calendar, Jira, and calendrome budgets/tasks into one unified view, helps prioritize, and creates linked calendar events + calendrome tasks for blocked time. Use when the user runs `/calendrome:week`, says "plan the week", "let's do weekly planning", "what's on this week", or asks for a budget overview. Also handles end-of-week timesheet export on Friday sessions.
argument-hint: "(no args)"
allowed-tools: Read, Bash
---

# Weekly Planning Session

Start-of-week planning that unifies calendar + Jira + calendrome budgets, then helps the user commit time. Read settings from `~/.claude/calendrome.local.md` before doing anything.

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
  to:   "<last Sunday ISO date>",
  category: "work"
}
```

(The range is the previous Mon–Sun. Both bounds are day-granular and
inclusive — passing this Monday as `to` would pull today's placements
into last week's review.)

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

**Google Calendar** — the full week, Mon–Sun:
`mcp__claude_ai_Google_Calendar__list_events` with:
- `calendarId`: `<calendar_id>`
- `timeMin`: this Monday 00:00:00 in `<calendar_timezone>`
- `timeMax`: this Sunday 23:59:59 in `<calendar_timezone>`
- `timeZone`: `<calendar_timezone>`

### Step 1.5 — Sync the week's calendar into calendrome

Calendrome does **not** auto-sync Google Calendar — the week view and
budgets only see what's imported, so push the whole fetched week
before presenting anything (otherwise meetings on days without a
morning brief are silently missing, #93).

Call `mcp__calendrome__sync_calendar_events` with all events from
Step 1, plus a `window` matching the fetched range:

- `window: { from: "<this Monday ISO date>", to: "<this Sunday ISO date>" }`
  — prunes synced-but-since-cancelled meetings inside the window. It
  only ever removes UNCONFIRMED gcal-sync rows, so placements,
  confirmed time, and habits are safe.
- Skip `transparency: "transparent"` / `AVAILABILITY_FREE`
  reminder-type events — nudges, not blockers.
- `is_meeting: true` for anything multi-attendee or
  sync/standup/review-like; `false` otherwise.
- `project_id`: match the event title against `project_prefixes`
  (case-insensitive substring vs `name`); else omit. When omitted,
  calendrome's `meeting_project_mappings` rules apply server-side —
  for recurring meetings, prefer creating a durable rule once
  (`add_meeting_project_mapping { pattern, project_id }`).
- Pass each event's Google `id` and `calendar_id` verbatim — the
  import upserts by id, so re-running is idempotent.

Run it silently — only surface errors. Because synced meetings with a
`project_id` count toward budgets, run Step 1's calendrome calls
(`get_all_budgets`, `list_tasks`) **after** this sync, not in the
parallel fan-out with the calendar fetch.

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

### Step 6 — Weekly Slack preview (start-of-week "here's my week" post)

Triggered on a Monday session, or any time the user asks ("slack preview", "week preview", "post for the team"). Produces a **copy-paste-ready Slack message** summarizing the week's plan in **outline form with ticket links** — useful as a recurring "here's where my hours are going" post, especially on a part-time schedule.

Build entirely from data already gathered in Steps 1–2 (budgets, scheduled task blocks, Jira issues, OOO blocks) — no new fetches needed if the planning view just ran.

**Hours per project:**
- If settings define hour targets (`weekly_hours_target` total, or a `weekly_hours` field per entry in `project_prefixes`), use those.
- Otherwise fall back to each project's budget `allocated_minutes` (or `scheduled_minutes` for planned-only).
- Round to whole/half hours and prefix with `~`.

**Tickets per project (the outline body):**
- List the Jira keys scheduled/planned for each project this week (from the calendrome task blocks' `notes` plus the Step 2 Jira pull).
- Render each as a Slack link: `<<browse-url>|<KEY>> — <short summary>`. Derive `<browse-url>` from the full `browse/` URL in the task `notes` when present; otherwise build `https://<site>/browse/<KEY>` from the project's configured Atlassian site.
- If a project has budgeted hours but no ticket, write `— no ticket assigned yet` instead of a sub-list.

**Out-days (OOO):**
- Scan the week's availability overrides / blocks for full-day `available: 0` entries (holidays, PTO) and any all-day OOO calendar events. List them on an `Out:` line; omit the line entirely if there are none.

**Output format** (Slack mrkdwn — `*bold*`, `<url|label>` links, `•`/`◦` bullets), inside a fenced block so it copies cleanly:

```
*Week of <Mon Mon D>* — my plan

• *<Project / client>* — ~<X>h
   ◦ <https://<site>/browse/ACME-42|ACME-42> — <short summary>
   ◦ <https://<site>/browse/ACME-51|ACME-51> — <short summary>
• *<Project / client>* — ~<X>h — no ticket assigned yet
• *<Internal project>* — ~<X>h — standups, internal, admin

Out: <day(s)>

<one-line focus / priority note>
```

Offer to adjust tone (more/less casual) and to plug in real hour targets if `weekly_hours_target` is not set in settings.

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
