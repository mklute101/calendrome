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
scheduling window. Windows are guidelines, not rules — they shape where the
planner suggests hours, but scheduling outside one just works and counts as
extra supply (no `open_time` needed first). The GUI defaults to the work view
so casual screen-shares never leak personal stuff. Availability overrides are
the frictionless answer to "Tuesday night I'm not doing anything" — one MCP
call from a single sentence to Claude.

- `list_categories` — all categories with their default windows
- `create_category` — define a new category with a window
- `update_category` — change the window or rename
- `block_time` — reserve a slot so the planner won't schedule into it
- `open_time` — announce extra availability ahead of time (never required)
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

### Commitments (prototype)
Goals (buckets of hours) plus YNAB-style envelope budgeting (#106). Prototype
surface — try it in a sandbox DB first
(`plugin/skills/sandbox/scripts/seed-commitments.mjs`).

- `create_goal` — bucket of hours toward a project: by-date or weekly refill, optional minimum chunk
- `list_goals` — goals with weekly-ask progress for a week
- `update_goal` — patch goal fields (null one of due/refill_period to flip flavor)
- `deactivate_goal` — soft delete; entries keep their goal link
- `place_goal_block` — schedule an unconfirmed block against a goal's bucket
- `assign_hours` — set a week's assigned minutes for an envelope (null = snoozed)
- `pull_hours` — move minutes between envelopes: zero-sum, logged
- `list_envelope_moves` — a week's pull history (Recent Moves), newest first
- `get_envelopes` — YNAB-style rows: assigned/activity/available + status line

### Calendar placement
- `place_task` — create a calendar event for a task (requires calendar client)
- `unplace_task` — remove the calendar event

### Timesheet
- `export_timesheet` — CSV or markdown, with optional totals
- `get_timesheet_summary` — structured data for programmatic consumers

### Layout
- `get_week_layout` — tasks + habits + events for a date range, by day

## Observability (optional)

Both servers ship an opt-in OpenTelemetry bootstrap
(`src/observability/otel.ts`). It is entirely inert by default — no
startup cost, no network egress — and activates only when
`CALENDROME_OTEL=1` is set on the process. When active, it exports
traces over OTLP HTTP (endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT`,
default `http://localhost:4318`) with `service.name` set to
`calendrome-mcp` or `calendrome-gui`. Nothing OTel-related ever
writes to stdout — the MCP server's stdout is the JSON-RPC transport.

Bring up the local trace backend (Grafana, Tempo, Loki, and
Prometheus in one container):

```bash
docker compose -f docker-compose.otel.yml up -d
```

Then run either server with the flag on:

```bash
CALENDROME_OTEL=1 node dist/src/mcp/server.js
CALENDROME_OTEL=1 node dist/src/gui/server.js
```

Open Grafana at `http://localhost:3000` (anonymous admin login by
default), go to Explore, pick the Tempo data source, and search for
`service.name = calendrome-mcp` (or `calendrome-gui`). Express and
outbound HTTP spans appear via auto-instrumentation. Traces from a
short-lived MCP session are flushed on shutdown, so they survive the
client killing the process.

Tear the backend down with
`docker compose -f docker-compose.otel.yml down`.

### Wide spans

Every MCP tool call runs inside one wide span (`tools/call <name>`,
created in `src/mcp/call-tool.ts`), and every GUI `/api` request is
one auto-instrumented request span enriched by a middleware — one
span per unit of work carrying many attributes, rather than many thin
spans. Alongside the semantic conventions (`rpc.system=jsonrpc`,
`rpc.method=tools/call`; standard HTTP attributes on the GUI side),
spans carry domain attributes: `calendrome.tool`, `calendrome.tz`,
`calendrome.local_day`, `calendrome.utc_day`,
`calendrome.entity_type`, `calendrome.entity_id`,
`calendrome.rows_written`, and `calendrome.db_path`. The deeper
attributes flow up from the core `time_entry` write paths via
`recordEntityWrite` (`src/observability/spans.ts`), so both surfaces
record identically. Failing tool calls get `recordException` and
ERROR status while the client still receives the usual `isError`
text result.

`local_day` and `utc_day` are recorded side by side on purpose: a
day-bucketing disagreement (an evening local-time entry rolling to
the next UTC day) becomes a Tempo TraceQL query instead of a bug
report —

```
{ span.calendrome.local_day != nil && span.calendrome.utc_day != nil && span.calendrome.local_day != span.calendrome.utc_day }
```

The local day is computed in the process's resolved timezone;
`CALENDROME_TZ` overrides it (useful in tests, or when the machine's
zone is not the one you live in).

Redaction is enforced at a single boundary: span attributes can only
be set through the allowlist in `src/observability/spans.ts`.
Structural values pass (ids, enums, counts, day strings, timezone
names, paths); project names, client names, and free-text note or
title bodies can never reach a span. Exception events and status
messages go through the same boundary: errors are recorded via
`recordSpanError`, which drops everything after the first colon in
the message (the repo's error convention puts echoed caller input
there) and reduces stacks to their frames. Tests assert the boundary
holds (`tests/observability-spans.test.ts`).

### Health checks

Tracing shows what happened; the health checks say whether the
database is in a bad state right now. Five invariant assertions
(`src/health/checks.ts`) run as single SQL queries and are exposed
identically as `GET /api/health` on the GUI server and a
`check_health` MCP tool — an assistant session can call it at the
start of planning and see failures before acting on bad data. Both
surfaces report the resolved database path, so "are the GUI and MCP
serving the same file?" is answered by diffing the two responses.

For scheduled runs there is a CLI wrapper:

```bash
node scripts/check-health.mjs            # exit 0 healthy, 1 failing, 2 broken
node scripts/check-health.mjs --json     # raw HealthReport
node scripts/check-health.mjs --notify   # macOS notification on failure
```

It reads `CALENDROME_DB` (defaulting to `calendrome.db` at the repo
root) and needs a build (`npm run build`). Silence is the expected
output — schedule it nightly and you hear about it only when an
invariant breaks. On macOS, a `launchd` agent at
`~/Library/LaunchAgents/com.calendrome.health.plist` along these
lines runs it every morning (a run missed while the machine slept
fires on wake):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.calendrome.health</string>
  <key>ProgramArguments</key><array>
    <string>/path/to/node</string>
    <string>/path/to/calendrome/scripts/check-health.mjs</string>
    <string>--notify</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>CALENDROME_DB</key><string>/path/to/calendrome.db</string>
  </dict>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardErrorPath</key>
  <string>/tmp/calendrome-health.log</string>
</dict></plist>
```

Load it once with `launchctl load
~/Library/LaunchAgents/com.calendrome.health.plist`.
