# Calendrome

## Vision

A local, project-based task scheduling engine that replaces Reclaim.ai. Instead of Reclaim's rigid WORK/PERSONAL split, tasks belong to **projects**, and each project maps to a **Google Calendar** — making sharing per-project natural. Exposed as a Claude Code MCP server so it plugs into the existing planner workflow.

## What We're Keeping from Reclaim

| Reclaim Feature | Keep? | Notes |
|---|---|---|
| Task CRUD (create, update, delete, list, search) | Yes | Core functionality |
| Priority-based ordering (P1 > P2 > P3 > P4) | Yes | Used by the planner skills, not an auto-scheduler |
| Duration in 15-min chunks | Yes | Works well with calendar blocks |
| Due dates + snooze/schedule-after | Yes | Essential for planning |
| Start/stop/complete task lifecycle | Yes | Workflow tracking |
| Calendar event creation | Yes | But via Google Calendar API directly, manually placed |
| Time policies (per-project hour budgets) | Yes | Weekly hour budgets per project — soft caps with warnings |
| GTD Inbox (quick capture) | Yes | Already built in the connector |
| Habits | Yes | Recurring time blocks that auto-generate calendar events |

## What We're Dropping

| Reclaim Feature | Why |
|---|---|
| WORK/PERSONAL category split | Replaced by projects |
| Smart auto-scheduling | Replaced by collaborative `daily-planner` / `weekly-planner` Claude skills that read from calendrome |
| Rescheduling on conflict | The planner skills handle re-layout interactively |
| Scheduling links | Not relevant |
| Otter meeting integration | Separate concern, can keep in its own tool |
| NLP interpreter endpoint | Claude *is* the NLP layer |
| AWS infrastructure (Lambda/DynamoDB/API GW) | Going local |
| OAuth flow | Not needed for local MCP |

## What We're Adding / Doing Better

| New Feature | Why |
|---|---|
| **Project-based organization** | Tasks belong to projects (SAN, ATN, AP, M, MTB, etc.) |
| **Project ↔ Calendar mapping** | Each project can have its own Google Calendar; sharing is per-calendar |
| **Weekly hour budgets per project** | "SAN = 20h/week, MTB = 5h/week" — soft cap, warns when exceeded |
| **Habits as recurring time blocks** | Schedule + duration that generates calendar events and counts toward budget |
| **Timesheet CSV export** | Date range → date, project, hours, task, notes — paste into anything |
| **Read APIs for planner skills** | Free slots, this-week tasks, budget status, today's habits — fuel the daily/weekly planner |
| **Local-first storage** | SQLite — fast, portable, no AWS dependency |
| **MCP server (stdio)** | Direct Claude Code integration, no network hop |
| **GitHub-hosted** | Enable Claude Code remote agent usage |
| **Prefix convention built-in** | SAN:, ATN:, etc. are first-class, not just naming convention |
| **Task dependencies** | Optional: "do X before Y" |
| **Actual time tracking** | Track time spent vs estimated (start/stop timestamps) |

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Claude Code     │────▶│  TaskEngine MCP   │────▶│  Google Calendar    │
│  (planner, etc.) │◀────│  Server (stdio)   │◀────│  API                │
└─────────────────┘     └──────┬───────────┘     └─────────────────────┘
                               │
                        ┌──────▼───────┐
                        │   SQLite DB   │
                        │  (local)      │
                        └──────────────┘
```

### Tech Stack

- **Runtime**: Node.js (TypeScript) — matches existing connector
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)
- **Database**: SQLite via `better-sqlite3` — zero config, fast, local
- **Calendar**: Google Calendar API via `googleapis`
- **Build**: TypeScript, esbuild for bundling

---

## Data Model

### Projects

```sql
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,        -- e.g. "san", "atn", "mtb"
  name        TEXT NOT NULL,           -- e.g. "Straight Arrow News"
  prefix      TEXT NOT NULL UNIQUE,    -- e.g. "SAN"
  calendar_id TEXT,                    -- Google Calendar ID (null = primary)
  color       TEXT,                    -- hex color for UI
  weekly_budget_minutes INTEGER,       -- soft weekly hour budget (null = no budget)
  active      INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
```

### Time Policies (per-project scheduling windows)

```sql
CREATE TABLE time_policies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT REFERENCES projects(id),
  day_of_week INTEGER NOT NULL,        -- 0=Sun, 1=Mon, ... 6=Sat
  start_time  TEXT NOT NULL,           -- "09:00"
  end_time    TEXT NOT NULL,           -- "17:00"
  timezone    TEXT DEFAULT 'America/Chicago'
);
```

### Tasks

```sql
CREATE TABLE tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  title           TEXT NOT NULL,
  notes           TEXT,
  priority        TEXT NOT NULL DEFAULT 'LOW',  -- CRITICAL, HIGH, MEDIUM, LOW
  status          TEXT NOT NULL DEFAULT 'NEW',  -- NEW, SCHEDULED, IN_PROGRESS, COMPLETE, ARCHIVED
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  time_spent_minutes INTEGER DEFAULT 0,
  due             TEXT,                         -- ISO 8601
  snooze_until    TEXT,                         -- don't schedule before this
  calendar_event_id TEXT,                       -- linked Google Calendar event
  depends_on      INTEGER REFERENCES tasks(id), -- optional dependency
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
```

### Inbox (quick capture, unprocessed)

```sql
CREATE TABLE inbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  notes       TEXT,
  processed   INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
```

### Time Log (actual time tracking)

```sql
CREATE TABLE time_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  started_at  TEXT NOT NULL,
  stopped_at  TEXT,
  duration_minutes INTEGER  -- computed on stop
);
```

### Habits (recurring time blocks)

```sql
CREATE TABLE habits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  title           TEXT NOT NULL,
  notes           TEXT,
  duration_minutes INTEGER NOT NULL,
  days_of_week    TEXT NOT NULL,       -- CSV "1,2,3,4,5" (0=Sun..6=Sat)
  start_time      TEXT NOT NULL,       -- "07:00"
  timezone        TEXT DEFAULT 'America/Chicago',
  active          INTEGER DEFAULT 1,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE habit_instances (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id           INTEGER NOT NULL REFERENCES habits(id),
  scheduled_start    TEXT NOT NULL,    -- ISO 8601
  scheduled_end      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PLANNED', -- PLANNED, COMPLETE, SKIPPED
  calendar_event_id  TEXT,
  completed_at       TEXT,
  UNIQUE(habit_id, scheduled_start)    -- idempotent generation
);
```

---

## MCP Tools

### Task Management
| Tool | Description | Maps to Reclaim |
|---|---|---|
| `create_task` | Create task in a project | `create_reclaim_task` |
| `update_task` | Update task fields | `update_reclaim_task` |
| `delete_task` | Delete/cancel a task | DELETE endpoint |
| `list_tasks` | List tasks with filters | `list_reclaim_tasks` |
| `search_tasks` | Full-text search with filters | `search_reclaim_tasks` |
| `start_task` | Begin working (start timer) | `planner/start/task` |
| `stop_task` | Pause working (stop timer) | `planner/stop/task` |
| `complete_task` | Mark done | `planner/done/task` |

### Layout & Manual Placement
| Tool | Description |
|---|---|
| `get_free_slots` | Given range + optional project, return free windows from Google Calendar |
| `get_week_layout` | Tasks + habit instances + calendar events for a date range, grouped by day |
| `place_task` | Create a calendar event for a task at a specific time (manual placement) |
| `unplace_task` | Remove the calendar event, set task back to NEW |

### Projects & Budgets
| Tool | Description |
|---|---|
| `list_projects` | List all projects |
| `create_project` | Create a project with calendar mapping and weekly budget |
| `update_project` | Update project settings (including budget) |
| `get_project_budget` | For project + week, return allocated/spent/scheduled/remaining/over_budget |
| `get_all_budgets` | Same, for every active project — used by the weekly planner |

### Habits
| Tool | Description |
|---|---|
| `create_habit` / `update_habit` / `list_habits` / `deactivate_habit` | CRUD on habit templates |
| `generate_habit_instances` | Materialize habit_instances rows for a date range (idempotent) |
| `complete_habit_instance` / `skip_habit_instance` | Mark instances done or skipped |

### Timesheets
| Tool | Description |
|---|---|
| `export_timesheet` | Date range → CSV (date, project, hours, task, notes) |

### Inbox
| Tool | Description | Maps to Reclaim |
|---|---|---|
| `inbox_add` | Quick capture | `add_to_inbox` |
| `inbox_list` | List unprocessed items | `list_inbox` |
| `inbox_next` | Get next item for processing | `get_next_inbox_item` |
| `inbox_process` | Convert inbox item to task | `mark_inbox_processed` + `create_task` |

### Time Policies
| Tool | Description | New |
|---|---|---|
| `set_time_policy` | Set scheduling windows for a project | New |
| `get_time_policies` | View current policies | New |

---

## Planner Integration Model

Calendrome is a **data source** for the existing `daily-planner` and
`weekly-planner` Claude skills, not an auto-scheduler. The skills already
walk through layout collaboratively, pulling from Jira and Google Calendar.
Calendrome adds:

1. **Free slots** — query GCal for busy times, return available windows so
   the planner skill can suggest where to put tasks.
2. **Week layout** — tasks + habit instances + existing calendar events for
   a date range, grouped by day, so the skill can present "here's your week".
3. **Budget status** — allocated / spent / scheduled / remaining per project
   so the skill can warn "SAN is at 22h/20h this week".
4. **Manual placement** — `place_task` creates the calendar event when the
   user agrees with a suggestion. No auto-write.
5. **Habit materialization** — `generate_habit_instances` converts habit
   templates into concrete instances for a week, which the planner then
   places (or which a future job auto-places).

### Budget semantics

- **Soft cap.** Going over budget never blocks an operation.
- **Spent** = sum of `time_log.duration_minutes` within the week.
- **Scheduled** = sum of habit instance durations + tasks with
  `calendar_event_id` set, whose start falls within the week.
- **Over budget** when `spent + scheduled > weekly_budget_minutes`.
- Projects with `weekly_budget_minutes = NULL` never warn.

---

## Implementation Phases

### Phase 1: Foundation (TDD)

**Part A — Red: write all tests first.**
- [ ] Project scaffolding (TypeScript, Vitest, better-sqlite3, MCP SDK)
- [ ] `tests/db/migrations.test.ts`
- [ ] `tests/projects.test.ts`
- [ ] `tests/tasks.test.ts`
- [ ] `tests/inbox.test.ts`
- [ ] `tests/habits.test.ts`
- [ ] `tests/time-log.test.ts`
- [ ] `tests/budgets.test.ts`
- [ ] `tests/timesheet.test.ts`
- [ ] `tests/mcp-tools.test.ts`
- [ ] `tests/integration/lifecycle.test.ts`
- [ ] Confirm `npm test` runs and every test fails

**Part B — Green: implement until all tests pass.**
- [ ] `src/db/schema.sql`, `src/db/migrate.ts`, `src/db/connection.ts`
- [ ] `src/projects.ts`
- [ ] `src/tasks.ts` (CRUD + status machine)
- [ ] `src/inbox.ts`
- [ ] `src/time-log.ts`
- [ ] `src/habits.ts` (CRUD + instance generation)
- [ ] `src/budgets.ts`
- [ ] `src/timesheet.ts`
- [ ] `src/mcp/server.ts` + per-tool handlers (mock GCal)
- [ ] All tests green

**Goal**: Can create/manage projects, tasks, habits, time logs, budgets,
and CSV exports via the MCP server. No real Google Calendar yet — GCal
calls mocked.

### Phase 2: Google Calendar Integration
- [ ] Google Calendar OAuth, refresh token stored locally
- [ ] `get_free_slots` reads busy times
- [ ] `place_task` / habit instance writes real events
- [ ] Replace GCal mocks with the real client; tests use a recorded
      fixture or a dedicated test calendar

**Goal**: Manual placement and free-slot queries work end-to-end against
a real calendar.

### Phase 3: Planner Skill Integration
- [ ] Update `daily-planner` skill to call calendrome MCP tools alongside
      Jira and Google Calendar
- [ ] Update `weekly-planner` skill to use `get_all_budgets` and
      `get_week_layout`
- [ ] Verify the collaborative planning flow works end-to-end

**Goal**: Full replacement of Reclaim in daily workflow.

### Phase 4: Polish
- [ ] Timesheet export refinements (per-project breakdown, totals row)
- [ ] Migration importer for active Reclaim tasks
- [ ] Analytics (hours per project over time)
- [ ] Bulk operations

---

## Reclaim API Reference (from Insomnia collection)

For migration and feature parity reference:

```
Base URL: https://api.app.reclaim.ai/api
Auth: Bearer {API_KEY}

GET    /tasks                          List all tasks (status filter param)
POST   /tasks                          Create task
GET    /tasks/{id}                     Get task by ID
PATCH  /tasks/{id}                     Update task
DELETE /tasks/{id}                     Delete/cancel task

POST   /planner/done/task/{id}         Mark task complete
POST   /planner/start/task/{id}        Start task (in progress)
POST   /planner/stop/task/{id}         Stop/pause task
POST   /planner/unarchive/task/{id}    Restore archived task

GET    /events?start=&end=&sourceDetails=true   Calendar events with Reclaim metadata
GET    /users/current                  Current user profile + settings
GET    /timeschemes                    Time policies (work/personal hours)
GET    /scheduling-link                Scheduling links
GET    /scheduling-link/group          Scheduling link groups

POST   /planner/start/habit/{id}       Start habit
POST   /planner/stop/habit/{id}        Stop habit
POST   /interpreter/message            NLP interpreter

Task create body:
{
  "title": "string",
  "notes": "string",
  "eventCategory": "WORK|PERSONAL",
  "timeChunksRequired": int (15-min chunks),
  "minChunkSize": int,
  "maxChunkSize": int,
  "priority": "P1|P2|P3|P4",
  "alwaysPrivate": bool,
  "due": "ISO 8601",
  "snoozeUntil": "ISO 8601"
}
```

---

## Existing Code to Reuse

From `~/dev/tools/reclaim_claude_connector/`:

| File | What's reusable |
|---|---|
| `lambda/mcp/index.ts` | Tool definitions, priority mapping, date helpers, response formatting |
| `lambda/task/index.ts` | Task request/response interfaces, validation logic |
| `lambda/shared/utils.ts` | GTD inbox data model (adapt from DynamoDB to SQLite) |
| `spec.md` | API reference, parameter transformation docs |

---

## Open Questions

1. **Google Calendar auth**: Use a service account or OAuth with stored refresh token? Service account is simpler for personal use but can't access personal calendars easily. OAuth needs one-time browser auth.

2. **Habit instance generation cadence**: On demand by the planner skills, or a nightly cron that materializes the next 7 days? Start with on-demand, revisit if it gets annoying.

3. **Migration**: Import existing 600+ Reclaim tasks? Probably filter to just active (NEW/SCHEDULED/IN_PROGRESS) and map to projects by prefix.

4. **Multi-calendar complexity**: If SAN and ATN both map to the same "primary" calendar, budget queries need to coordinate across projects. If they're separate calendars, simpler but user needs to set up those calendars first.

5. **Remote agent**: What does the Claude Code hosted agent need? Just a GitHub repo with the MCP server? Or does it need to be deployed somewhere?
