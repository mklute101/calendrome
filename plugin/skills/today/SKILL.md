---
name: today
description: Daily working session for calendrome — morning brief, active task assistant during the day, and end-of-day wrap-up. Use when the user runs `/calendrome:today`, says "good morning", "what's on today", "let's start the day", "wrap up", "EOD", "done for today", or asks to plan or review the current day. Pulls from Google Calendar and Jira, posts time blocks, and transitions Jira issues as work completes.
argument-hint: "(no args — optional 'wrap' to skip morning and go straight to EOD)"
allowed-tools: Read, Bash
---

# Daily Working Session

Three phases: morning brief, active assistance, end-of-day wrap. Read settings from `.claude/calendrome.local.md` before doing anything.

## Settings used

From `.claude/calendrome.local.md` frontmatter:

- `atlassian_cloud_id`, `atlassian_account_id` — for Jira queries
- `calendar_timezone`, `calendar_id` — for calendar queries
- `project_prefixes` — list of `{prefix, project_id, name}` for client tagging
- `project_repos` — optional `{prefix: filesystem_path}` for code-task readiness
- `personal_email` — for Gmail context lookups (read-only)

If the settings file is missing, tell the user to run `/calendrome:onboard` and stop.

## Local time override

When the user mentions a non-default timezone ("8pm Rio", "7pm Berlin", "3pm local"), convert to `calendar_timezone` for the calendar API but confirm in both timezones. Common aliases: Rio → America/Sao_Paulo, Berlin → Europe/Berlin.

## Phase 1: Morning Brief

### Step 1 — Fetch today's calendar

Call Google Calendar `list_events`:
- `calendarId`: `<calendar_id>`
- `timeMin`: today 00:00:00 in `<calendar_timezone>` (ISO 8601)
- `timeMax`: today 23:59:59 in `<calendar_timezone>`
- `timeZone`: `<calendar_timezone>`

### Step 2 — Extract Jira context from calendar events

Scan event titles for:
- Explicit Jira keys (e.g., `A2-105`, `WEB-1806`)
- Project/task references that map to known tickets (e.g., a calendar block titled "ATN: Beehiiv" likely maps to a known ticket)

Build a focused JQL query combining what was found:
- Any keys extracted: `key IN (A2-105, A2-103, ...)`
- In-progress work: `status = "In Progress"`
- Scoped to user: `assignee = "<atlassian_account_id>"`

Example:
```
assignee = "<atlassian_account_id>" AND (key IN (A2-105) OR status = "In Progress") ORDER BY priority DESC
```

Call `mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql`:
- `cloudId`: `<atlassian_cloud_id>`
- `fields`: `["summary", "status", "priority", "project"]`
- `maxResults`: 10

If no keys are found, fall back to:
```
assignee = "<atlassian_account_id>" AND status = "In Progress" ORDER BY priority DESC
```

### Step 3 — Present today's view

Categorize events into **meetings** (standups, syncs, reviews, multi-attendee Zoom), **task blocks** (prefix-tagged solo work, focus time), and **personal** (workout, lunch, stretching). Format as a chronological table:

```
## Today — [Day, Month Date YYYY]

### Timeline
| Time        | Type     | Item                 | JIRA   |
|-------------|----------|----------------------|--------|
| 09:00-09:30 | Meet     | Standup              |        |
| 09:30-11:00 | Task     | ATN: Beehiiv         | A2-105 |

### Active JIRA Tickets
- [KEY] Summary — Status (linked to calendar block / no block today)
```

Compact only; no full backlog.

### Step 4 — Readiness check

For each task block, ask: "Do we have what we need to do this?" Gather context proactively:

- **Code task** (prefix has a `project_repos` entry) — pull Jira ticket detail, check open PRs (`gh pr list` in the repo), note the working branch.
- **PR review** — fetch PR diff/summary.
- **Personal task** (prefix `M:` or similar) — search Gmail or local notes for the latest context.
- **Meeting prep** — check for linked agenda doc or relevant tickets.

Format:
```
### Ready to go?
- **ATN: Franchise Corner (A2-103)** — PR #XX open, branch sprint72/...; last comment: "fix archive pages". Ready
- **SAN: WEB-1806** — No PR found. May need branch.
- **M: Call IRS** — Last MO DOR email 2/16 (unread, encrypted). Open first.
```

After presenting:

> "Anything else you need before diving in? Otherwise let me know when you:
> - **Start or finish** a task (I'll update Jira)
> - **Need a time block** (say what you're working on and how long)
> - **Want to wrap up** for the day"

## Phase 2: Active Assistant

Stay engaged through the day. Respond to these patterns:

### Task completion
"Done with [task]", "finished [ticket]", "completed ATN-42":
1. Identify the Jira ticket (by key or matching description)
2. Use `mcp__plugin_atlassian_atlassian__getTransitionsForJiraIssue` to find available transitions
3. Ask: "Want me to transition [KEY] to [next status]?"
4. On confirm, use `mcp__plugin_atlassian_atlassian__transitionJiraIssue`
5. Log for the wrap summary

### Quick calendar block
"I'm going to work on X", "next hour on Y":

Defer to `/calendrome:block` for the actual placement, OR inline:
1. Parse activity + duration (default 30 min)
2. Apply prefix from `project_prefixes` if context matches (case-insensitive substring against `name`)
3. Get current time in `<calendar_timezone>`
4. Call `mcp__claude_ai_Google_Calendar__create_event`
5. Confirm: "Blocked: [title] [HH:MM]–[HH:MM]"

### Schedule awareness
- Meeting in next 15 min → "Heads up: [meeting] in [X] minutes"
- Working past a scheduled task's end time → gentle nudge

### Jira status updates
User mentions starting a ticket → offer to transition To Do → In Progress.

## Phase 3: End-of-Day Wrap

Triggered by "wrap up", "done for today", "EOD", "calling it a day", or `/calendrome:today wrap`.

1. **Summarize the day**: completed tasks/tickets with status changes, blocks created, anything still in progress.
2. **Flag pending updates**: tickets worked on but not transitioned.
3. **Optional timesheet log**: if the user logged real work that wasn't auto-tracked, offer to call `mcp__calendrome__log_time` for the relevant intervals (round to 15-minute increments — see `feedback_time_log_increments` convention).
4. End with a brief wrap message.

## Edge cases

- Settings file present but missing keys (e.g., `atlassian_account_id` empty) → skip the Jira step gracefully, note "Atlassian not configured — run `/calendrome:onboard` to add."
- Calendar MCP unreachable → fall back to "I don't have today's calendar; what's on?"
