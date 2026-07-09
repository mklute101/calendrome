---
name: today
description: Daily working session for calendrome — morning brief, active task assistant during the day, and end-of-day wrap-up. Use when the user runs `/calendrome:today`, says "good morning", "what's on today", "let's start the day", "wrap up", "EOD", "done for today", or asks to plan or review the current day. Pulls from Google Calendar and Jira, posts time blocks, and transitions Jira issues as work completes.
argument-hint: "(no args — optional 'wrap' to skip morning and go straight to EOD)"
allowed-tools: Read, Bash
---

# Daily Working Session

Three phases: morning brief, active assistance, end-of-day wrap. Read settings from `~/.claude/calendrome.local.md` before doing anything.

## Settings used

From `~/.claude/calendrome.local.md` frontmatter:

- `atlassian_cloud_id`, `atlassian_account_id` — for Jira queries
- `calendar_timezone`, `calendar_id` — for calendar queries
- `project_prefixes` — list of `{prefix, project_id, name}` for client tagging
- `project_repos` — optional `{prefix: filesystem_path}` for code-task readiness
- `personal_email` — for Gmail context lookups (read-only)

If the settings file is missing, tell the user to run `/calendrome:onboard` and stop.

## Local time override

When the user mentions a non-default timezone ("8pm Rio", "7pm Berlin", "3pm local"), convert to `calendar_timezone` for the calendar API but confirm in both timezones. Common aliases: Rio → America/Sao_Paulo, Berlin → Europe/Berlin.

## Phase 1: Morning Brief

### Step 0 — Yesterday's pending review

Before today's plan, close out yesterday. Call:

```
mcp__calendrome__list_pending_review({
  from: <yesterday's date, YYYY-MM-DD>,
  to:   <yesterday's date, YYYY-MM-DD>,
  category: 'work'
})
```

(Ranges are day-granular and inclusive — pass plain dates, not
timestamps; a timestamp is bucketed to its UTC day.)

If the list is empty, skip to Step 1.

Otherwise render a compact bullet list (title, planned hours, time range) and ask **one** freeform question. Example:

```
Yesterday has 4 entries waiting for review:
  · ACME-42 login hotfix       2.0h placed (09:00–11:00)
  · ACME Internal Meeting      0.5h placed (14:00–14:30)
  · Newsletter feed (ACME-41)  2.0h placed (11:00–13:00)
  · GLBX PR review             1.0h placed (15:00–16:00)

How'd yesterday actually go?
```

Then wait for the user's single sentence.

#### Resolving the sentence

Read the sentence, map each phrase to one of the listed entries (or a brand-new entry), and fire all MCP calls **in parallel in one turn**:

- **Amended duration** ("4h on the login thing") → `confirm_placement(id, { actual_minutes: 240 })`
- **As-placed / "as planned"** ("the rest as placed", "standup as scheduled") → `confirm_placement(id)` with no amendment
- **Skipped / didn't happen** ("skip the meeting", "we cancelled standup") → `skip_placement(id)`
- **New work not on the list** ("I also spent an hour on the dashboard bug") → `log_time(...)`. Round to 15-minute increments. **Before logging, always try to link a task**: if the notes contain a Jira key (e.g., `ACME-43`) or otherwise map to a known task, call `mcp__calendrome__search_tasks { query }` first and pass the matched `task_id` to `log_time`. Only log without `task_id` when the search rules out a match — that's a legitimate one-off (e.g., "subdomain SEO investigation" with no ticket). Don't ship an entry where the user's own conversation referenced a ticket but the entry isn't linked to it.
- **Reschedule** ("the PR review actually ran 16:00–17:00") → `move_placement(id, new_start_at, { new_end_at? })`, then `confirm_placement` if duration was also amended.

#### Edge cases (be explicit)

1. **"Everything was as planned"** / "all good" / "as placed" → call `confirm_placement(id)` for every UNCONFIRMED entry, no amendments.
2. **Partial coverage** — the sentence names some entries but not all. For the leftovers, ask **one** targeted question covering them together: "You didn't mention the standup or the PR review — confirm both as-placed, or skip either?" — NEVER walk through them one by one.
3. **New work mentioned** — fire `log_time` for the new entry in the same parallel batch alongside the confirms/skips. If the user didn't name a project, infer from prefix or ask in the leftover question.
4. **Unaccounted-for entry** — same as #2. One question, group the leftovers.

After all calls resolve, summarize back briefly:

```
Logged: 7.5h across 3 projects (ACME 5h, GLBX 1h, internal 1.5h skipped). Ready for today.
```

Then proceed to Step 1.

### Step 1 — Fetch today's calendar

Call Google Calendar `list_events`:
- `calendarId`: `<calendar_id>`
- `timeMin`: today 00:00:00 in `<calendar_timezone>` (ISO 8601)
- `timeMax`: today 23:59:59 in `<calendar_timezone>`
- `timeZone`: `<calendar_timezone>`

### Step 1.5 — Sync calendar into calendrome

Calendrome does **not** auto-sync Google Calendar — events only land in it when imported. Right after fetching the calendar, push today's events into calendrome so its layout matches reality (otherwise blocks, the week view, and EOD review silently miss meetings).

Call `mcp__calendrome__sync_calendar_events` with the events from Step 1:

- Skip `transparency: "transparent"` / `AVAILABILITY_FREE` reminder-type events (bill reminders, tentative holds) — those are nudges, not blockers.
- `is_meeting: true` for anything multi-attendee or sync/standup/review-like; `false` otherwise.
- `project_id`: match the event title against `project_prefixes` (case-insensitive substring vs `name`); use that prefix's `project_id`, else `personal` for clearly personal items, else omit.
- Pass each event's Google `id` and `calendar_id` verbatim — the import **upserts by id**, so re-running the brief is idempotent and won't create duplicates. Do **not** pass `clear_range` (it deletes rows in the window and can take placements with it); rely on upsert instead.

This runs every morning brief, silently — only surface it if the sync errors.

### Step 2 — Extract Jira context from calendar events

Scan event titles for:
- Explicit Jira keys (e.g., `ACME-30`, `GLBX-18`)
- Project/task references that map to known tickets (e.g., a calendar block titled "ACME: Newsletter" likely maps to a known ticket)

Build a focused JQL query combining what was found:
- Any keys extracted: `key IN (ACME-30, ACME-28, ...)`
- In-progress work: `status = "In Progress"`
- Scoped to user: `assignee = "<atlassian_account_id>"`

Example:
```
assignee = "<atlassian_account_id>" AND (key IN (ACME-30) OR status = "In Progress") ORDER BY priority DESC
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
| Time        | Type     | Item                 | JIRA    |
|-------------|----------|----------------------|---------|
| 09:00-09:30 | Meet     | Standup              |         |
| 09:30-11:00 | Task     | ACME: Newsletter     | ACME-30 |

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
- **ACME: Landing page (ACME-28)** — PR #XX open, branch sprint72/...; last comment: "fix archive pages". Ready
- **GLBX: GLBX-18** — No PR found. May need branch.
- **M: Call dentist** — last email 2/16 (unread). Open first.
```

After presenting:

> "Anything else you need before diving in? Otherwise let me know when you:
> - **Finish** a task (I'll transition Jira)
> - **Need a time block** (say what you're working on and how long)
> - **Want to wrap up** for the day"

## Phase 2: Active Assistant

Stay engaged through the day. Respond to these patterns:

### Task completion
"Done with [task]", "finished [ticket]", "completed ACME-42":
1. Identify the Jira ticket (by key or matching description)
2. Use `mcp__plugin_atlassian_atlassian__getTransitionsForJiraIssue` to find available transitions
3. Ask: "Want me to transition [KEY] to [next status]?"
4. On confirm, use `mcp__plugin_atlassian_atlassian__transitionJiraIssue`
5. Log for the wrap summary

### Quick calendar block
"I'm going to work on X", "next hour on Y":

Calendrome owns placement — **never** call `mcp__claude_ai_Google_Calendar__create_event` directly. Either defer to `/calendrome:block`, or inline the same workflow:

1. Parse activity + duration (default 30 min).
2. Apply prefix from `project_prefixes` if context matches (case-insensitive substring against `name`).
3. Find or create the task in the matched project:
   - `mcp__calendrome__search_tasks { query }` to locate an existing task.
   - If none, `mcp__calendrome__create_task { project_id, title, duration_minutes }` and capture `task.id`.
4. Get current time in `<calendar_timezone>`.
5. Call `mcp__calendrome__place_task { task_id, start }` — this creates the placement and the paired UNCONFIRMED `time_entry`. The GCal event is synced from calendrome, not authored here.
6. Confirm: "Placed: [title] [HH:MM]–[HH:MM] — confirm in tomorrow's /calendrome:today."

### Schedule awareness
- Meeting in next 15 min → "Heads up: [meeting] in [X] minutes"
- Working past a scheduled task's end time → gentle nudge

### Jira status updates
User mentions starting a ticket → offer to transition To Do → In Progress. (Calendrome has no live timer — time is captured retroactively via `log_time` or by confirming placements during the EOD wrap.)

## Phase 3: End-of-Day Wrap

Triggered by "wrap up", "done for today", "EOD", "calling it a day", or `/calendrome:today wrap`.

Same list-then-one-sentence pattern as the morning brief — just scoped to **today's** placements that have already started.

### Step 1 — Pull today's pending entries

```
mcp__calendrome__list_pending_review({
  from: <today's date, YYYY-MM-DD>,
  to:   <today's date, YYYY-MM-DD>,
  category: 'work'
})
```

The range is day-granular and inclusive, so placements later today
that haven't started yet come back too. Drop any entry whose
`start_at` is still in the future before rendering — the wrap only
reviews work that has already started.

### Step 2 — Render and ask one question

```
Today so far — 3 entries waiting to be confirmed:
  · ACME-42 login hotfix      2.0h placed (09:00–11:00)
  · Standup                   0.5h placed (11:00–11:30)
  · Newsletter feed (ACME-41) 2.0h placed (13:00–15:00)

How'd today actually go?
```

### Step 3 — Resolve the sentence in parallel

Use the exact same mapping rules as Phase 1 Step 0:

- amended → `confirm_placement(id, { actual_minutes })`
- as-placed → `confirm_placement(id)`
- skipped → `skip_placement(id)`
- new work → `log_time({...})` (15-minute increments — see `feedback_time_log_increments` convention). Search for and link a matching calendrome task by `task_id` whenever the notes contain a Jira key or recognizable task identifier; only log unlinked when no match exists.
- reschedule → `move_placement(...)` then `confirm_placement` if needed

Apply the same four edge cases (everything-as-planned, partial coverage, new work, unaccounted-for entry).

### Step 4 — Jira + summary

After placements resolve:

1. **Flag pending Jira transitions**: tickets worked on today that haven't moved status — offer to transition.
2. **Summarize**: "Logged 7.0h. Open: ACME-42 still In Progress. See you tomorrow."

Catching up before bed means tomorrow's morning brief starts with a clean slate.

## Edge cases

- Settings file present but missing keys (e.g., `atlassian_account_id` empty) → skip the Jira step gracefully, note "Atlassian not configured — run `/calendrome:onboard` to add."
- Calendar MCP unreachable → fall back to "I don't have today's calendar; what's on?"
