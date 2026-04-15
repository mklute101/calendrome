# Calendrome

## Vision

A local, project-based task scheduling engine that replaces Reclaim.ai. Instead of Reclaim's rigid WORK/PERSONAL split, tasks belong to **projects**, and each project maps to a **Google Calendar** — making sharing per-project natural. Exposed as a Claude Code MCP server so it plugs into the existing planner workflow.

## What We're Keeping from Reclaim

| Reclaim Feature | Keep? | Notes |
|---|---|---|
| Task CRUD (create, update, delete, list, search) | Yes | Core functionality |
| Smart scheduling (auto-place tasks on calendar) | Yes | This is the killer feature |
| Priority-based scheduling (P1 > P2 > P3 > P4) | Yes | Higher priority = scheduled sooner |
| Duration in 15-min chunks | Yes | Works well with calendar blocks |
| Due dates + snooze/schedule-after | Yes | Essential for planning |
| Start/stop/complete task lifecycle | Yes | Workflow tracking |
| Calendar event creation | Yes | But via Google Calendar API directly |
| Time policies (work hours, personal hours) | Yes | But per-project, not global work/personal |
| Rescheduling on conflict | Yes | When a meeting appears, move task blocks |
| GTD Inbox (quick capture) | Yes | Already built in the connector |

## What We're Dropping

| Reclaim Feature | Why |
|---|---|
| WORK/PERSONAL category split | Replaced by projects |
| Habits | Low usage, can add later if needed |
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
| **Project-level time policies** | "SAN gets 4h/day Mon-Fri", "MTB gets 2h weekends" |
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
  time_budget_minutes INTEGER,         -- optional weekly budget
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

### Scheduling
| Tool | Description | Maps to Reclaim |
|---|---|---|
| `schedule_tasks` | Run the scheduler — place tasks on calendar | Core Reclaim magic |
| `get_schedule` | View scheduled tasks for a date range | `get_scheduled_tasks` |
| `reschedule` | Force re-evaluation of schedule | Reclaim auto-does this |

### Projects
| Tool | Description | New |
|---|---|---|
| `list_projects` | List all projects | New |
| `create_project` | Create a project with calendar mapping | New |
| `update_project` | Update project settings | New |
| `get_project_summary` | Tasks, time spent, budget usage for a project | New |

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

## Scheduling Algorithm (The Hard Part)

This is what makes Reclaim valuable. Our version:

### Input
1. All tasks with status NEW or SCHEDULED (not complete/archived)
2. Google Calendar events for the scheduling window (existing meetings, etc.)
3. Time policies per project (when tasks can be scheduled)
4. Task priorities, durations, due dates, snooze dates

### Algorithm
1. **Collect free slots**: Query Google Calendar for busy times, subtract from time policy windows to get available slots per project
2. **Sort tasks**: By priority (CRITICAL first), then by due date (soonest first), then by creation date (FIFO)
3. **Place tasks**: For each task, find the earliest available slot in its project's calendar that fits the duration. If no single slot fits, consider chunking (split across multiple blocks if min_chunk_size allows)
4. **Create calendar events**: For each placed task, create a Google Calendar event on the project's calendar with the task title prefixed by project prefix
5. **Update task status**: Mark as SCHEDULED with the calendar event ID

### Rescheduling Triggers
- New task created with higher priority than existing scheduled tasks
- Calendar event added/removed (meeting scheduled/cancelled)
- Manual `reschedule` command
- Task completed (frees up the slot)

### Constraints
- Respect time policies (don't schedule SAN work on weekends unless policy says so)
- Respect snooze_until dates
- Respect task dependencies (don't schedule child before parent)
- Don't double-book across project calendars if they share the same underlying calendar

---

## Implementation Phases

### Phase 1: Foundation (MVP)
- [ ] Project scaffolding (TypeScript, SQLite, MCP SDK)
- [ ] Database schema + migrations
- [ ] Project CRUD
- [ ] Task CRUD (create, update, delete, list, search)
- [ ] Task lifecycle (start, stop, complete)
- [ ] Inbox (add, list, next, process)
- [ ] MCP server with stdio transport
- [ ] GitHub repo setup

**Goal**: Can create/manage tasks and projects via Claude. No scheduling yet — just a better-organized task database.

### Phase 2: Google Calendar Integration
- [ ] Google Calendar auth (OAuth, store refresh token locally)
- [ ] Read calendar events (free/busy)
- [ ] Create/update/delete calendar events for tasks
- [ ] Time policies per project

**Goal**: Tasks can be manually placed on calendars, calendar is readable.

### Phase 3: Smart Scheduling
- [ ] Scheduling algorithm (slot finding, priority ordering, placement)
- [ ] Auto-schedule on task create/update
- [ ] Reschedule on conflict detection
- [ ] Chunked scheduling (split large tasks across blocks)

**Goal**: The core Reclaim replacement — tasks auto-appear on your calendar.

### Phase 4: Planner Integration
- [ ] Update planner skills (today, week) to use TaskEngine instead of Reclaim MCP
- [ ] Project-aware daily/weekly views
- [ ] Time tracking summaries per project
- [ ] Budget tracking (hours spent vs allocated per project per week)

**Goal**: Full replacement of Reclaim in daily workflow.

### Phase 5: Polish
- [ ] Task templates (recurring task patterns)
- [ ] Bulk operations
- [ ] Export/import (migrate existing Reclaim tasks)
- [ ] Analytics (time spent per project over time)

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

2. **Scheduling frequency**: Run scheduler on-demand only? Or watch for calendar changes? (Reclaim polls/webhooks.) Start with on-demand, add watch later.

3. **Migration**: Import existing 600+ Reclaim tasks? Probably filter to just active (NEW/SCHEDULED/IN_PROGRESS) and map to projects by prefix.

4. **Multi-calendar complexity**: If SAN and ATN both map to the same "primary" calendar, the scheduler needs to coordinate across projects. If they're separate calendars, simpler but user needs to set up those calendars first.

5. **Remote agent**: What does the Claude Code hosted agent need? Just a GitHub repo with the MCP server? Or does it need to be deployed somewhere?
