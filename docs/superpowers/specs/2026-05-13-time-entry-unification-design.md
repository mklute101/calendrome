# Unified `time_entry` model — design

**Date:** 2026-05-13
**Status:** Draft for review
**Closes:** [#44](https://github.com/mklute101/calendrome/issues/44) (placement confirmation flow)
**Supersedes:** [#66](https://github.com/mklute101/calendrome/issues/66) (week reconciliation — the drift class it surfaces cannot exist in this model)

---

## Problem

Calendrome currently has three sources of truth for "hours worked":

1. `time_log` — what `export_timesheet` and `harvest_push_timesheet` read
2. `tasks.time_spent_minutes` — what GUI budget bars read; bumped by `stop_task`, `log_time`, bulk imports, manual edits
3. `calendar_events` placements (via `task.calendar_event_id`) — what was *planned*

There is no MCP tool that surfaces drift between (1) and (2). Tasks can be marked COMPLETE with `time_spent_minutes > 0` and never produce `time_log` rows. The CSV silently under-reports by hours or days.

**Real-world hit (2026-05-12).** Pulled CSV for 2026-05-01 → 2026-05-08. Days 5/4–5/7 came back empty despite work being tracked at task level (~13–15h of beehiiv work, ~37h of SAN WEB-1806 bulk-imported tasks). Recovery required reconstructing from git commits, calendar events, and task notes to manually fire `log_time` calls.

The proposed fix in #44 (confirmation flow with PLACED / PENDING_REVIEW / CONFIRMED / SKIPPED states layered on top of `calendar_events`) addresses the *symptom* — past placements drifting silently — but leaves the three-stores-of-truth problem intact. Reconciliation in #66 layers a detection tool on top but does not prevent the next drift.

This design removes the drift class entirely.

## Approach

**Collapse the three stores into one `time_entry` table with two states:** `UNCONFIRMED` (planned, or past but not yet reviewed) and `CONFIRMED` (the human acknowledged it actually happened, with optional duration amendment).

There is no second store to be out of sync with. `tasks.time_spent_minutes` becomes a SQL view derived from `time_entry`. `calendar_events` placements become `time_entry` rows. `habit_instances` keeps its recurrence logic and gains a sidecar FK to its paired `time_entry` row.

**Personal/work separation moves to the export boundary.** Today's `export_timesheet` and `harvest_push_timesheet` do not filter by category — a personal-category entry would leak into a CSV or Harvest push. The new tools filter on `categories=['work']` by default; opting in to include personal is explicit.

**Live stopwatch (`start_task` / `stop_task`) is removed.** The actual user workflow is placement-first ("block 45 min for hotfix") rather than press-start / press-stop. Every hour logged in May 2026 went through `log_time` or `block_time`, none through `start_task`. Pomodoro / focus-bounded timing (issue [#22](https://github.com/mklute101/calendrome/issues/22)) is a separate future feature that does not reintroduce a tracking-style stopwatch.

## Out of scope

Each of these is its own issue (existing or to-be-filed) and **not** changed by this design.

- **Cascading reschedule.** "Block 45 min now, slide overlapping placements." Touches issue [#23](https://github.com/mklute101/calendrome/issues/23). Becomes easier in this model (one table to scan for overlaps) but stays a future issue.
- **Auto-scheduling.** "Just place this for me." Touches [#23](https://github.com/mklute101/calendrome/issues/23). Same future bucket.
- **Pomodoro / focus sessions** ([#22](https://github.com/mklute101/calendrome/issues/22)).
- **Backfill of Jan–Apr 2026 hours.** Only May 2026 is in scope (see Migration §0).
- **SKIPPED state with audit history.** Skip = delete. If you later want a tombstone trail, it's a separate issue.
- **GUI confirmation affordances.** Dashboard stays read-only. No confirm/skip buttons.
- **Spent-vs-scheduled visual split** ([#28](https://github.com/mklute101/calendrome/issues/28)) — independent, but becomes cheaper.
- **Recurring meeting → project auto-assign** ([#35](https://github.com/mklute101/calendrome/issues/35)) — independent, but becomes cheaper (a gcal-sync row gets a `project_id` and counts toward budget by construction).
- **Schema migration drift** ([#45](https://github.com/mklute101/calendrome/issues/45)) — independent infra; this design ships its own one-shot migration.
- **Multi-human teams** ([#47](https://github.com/mklute101/calendrome/issues/47)), **AI + human shared schedule** ([#36](https://github.com/mklute101/calendrome/issues/36)), **plugin onboard refactor** ([#59](https://github.com/mklute101/calendrome/issues/59)) — independent.
- **Steer "start a timer" phrasing toward placement-first** — a skill/prompt concern to be filed as a new issue after this spec lands; partial coverage embedded in `/calendrome:block` (§ Skill changes).

## Data model

### New table: `time_entry`

```sql
CREATE TABLE IF NOT EXISTS time_entry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- What it's for
  task_id         INTEGER REFERENCES tasks(id),     -- nullable: project-only entries allowed
  project_id      TEXT    REFERENCES projects(id),  -- nullable: purely-external gcal events

  -- When it happens
  start_at        TEXT    NOT NULL,                 -- ISO 8601
  end_at          TEXT    NOT NULL,                 -- ISO 8601
  actual_minutes  INTEGER,                          -- null = use end_at − start_at; non-null = amended on confirm

  -- Confirmation state
  status          TEXT    NOT NULL DEFAULT 'UNCONFIRMED'
                          CHECK (status IN ('UNCONFIRMED', 'CONFIRMED')),
  confirmed_at    TEXT,                             -- ISO 8601, null until confirmed

  -- Provenance / sync
  source          TEXT    NOT NULL
                          CHECK (source IN ('placement', 'gcal-sync', 'habit', 'manual')),
  external_id     TEXT,                             -- gcal event id (for source='gcal-sync' upsert)
  is_meeting      INTEGER NOT NULL DEFAULT 0,       -- preserved from calendar_events
  synced_at       TEXT,                             -- last gcal sync timestamp; null for non-synced
  harvest_entry_id INTEGER,                         -- migrated from time_log.harvest_entry_id

  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_time_entry_range ON time_entry(start_at, end_at);
CREATE INDEX idx_time_entry_status_start ON time_entry(status, start_at);
CREATE INDEX idx_time_entry_project ON time_entry(project_id);
CREATE INDEX idx_time_entry_task ON time_entry(task_id);
CREATE UNIQUE INDEX idx_time_entry_external ON time_entry(external_id) WHERE external_id IS NOT NULL;
```

### `tasks.time_spent_minutes` becomes a view

```sql
CREATE VIEW v_task_time_spent AS
SELECT
  task_id,
  SUM(COALESCE(actual_minutes, (julianday(end_at) - julianday(start_at)) * 24 * 60)) AS minutes
FROM time_entry
WHERE status = 'CONFIRMED' AND task_id IS NOT NULL
GROUP BY task_id;
```

GUI and other reads currently using `tasks.time_spent_minutes` switch to `LEFT JOIN v_task_time_spent USING (task_id)`.

### Tables / columns dropped

| Drop | Why |
|---|---|
| `time_log` (entire table) | Replaced by `time_entry` with `status='CONFIRMED'` |
| `calendar_events` (entire table) | Replaced by `time_entry` with `source='gcal-sync'` (or `'placement'` for task-linked) |
| `tasks.time_spent_minutes` (column) | Becomes the view above |
| `tasks.calendar_event_id` (column) | Unused; placement linkage now lives on `time_entry.task_id` |

### Tables kept but modified

| Keep | Change |
|---|---|
| `habit_instances` | Add `time_entry_id INTEGER REFERENCES time_entry(id)` — sidecar link to the paired `time_entry` row. Recurrence logic in `src/habits.ts` does not move. |
| `tasks` | Drop `time_spent_minutes` and `calendar_event_id` columns. |

### Invariants enforced by structure

1. Exactly one row per "thing on the calendar" — no drift class can exist.
2. UNCONFIRMED with `start_at < now()` = needs review. Brief queries are unambiguous.
3. `time_spent_minutes` cannot disagree with logged hours because it *is* logged hours.
4. Personal/work separation is a filter, not a store split.

## MCP surface

### New tools (4)

| Tool | Signature | Behavior |
|---|---|---|
| `confirm_placement` | `(time_entry_id, { actual_minutes?, project_id?, notes? })` | Flip UNCONFIRMED → CONFIRMED; stamp `confirmed_at`. Optional `actual_minutes` overrides the placed duration; optional `project_id` re-assigns. Idempotent on already-CONFIRMED entries (no-op + warning). |
| `skip_placement` | `(time_entry_id)` | Delete the row. Rejects on `status='CONFIRMED'`. Rejects on `source='gcal-sync'` (let gcal own those — delete the event there and let next sync remove). |
| `list_pending_review` | `({ from?, to?, category? })` | UNCONFIRMED entries with `start_at < now()`. `category` defaults to `'work'`. |
| `move_placement` | `(time_entry_id, new_start_at, { new_end_at?, preserve_duration? = true })` | Reschedule an unconfirmed entry. Only `status='UNCONFIRMED'`. Only `source IN ('placement','habit')`. Default preserves duration. |

### Removed tools (2)

| Tool | Reason |
|---|---|
| `start_task` | No live timer |
| `stop_task` | No live timer |

### Modified tools (7)

| Tool | Change |
|---|---|
| `place_task` | Creates an UNCONFIRMED `time_entry` with `source='placement'` (was: stamped `task.calendar_event_id`). |
| `unplace_task` | Deletes the UNCONFIRMED entry. Rejects on CONFIRMED. |
| `block_time` | Creates an UNCONFIRMED `time_entry`. Project-only or task-linked. Unchanged API. |
| `log_time` | Inserts a CONFIRMED `time_entry` directly. `task_id` becomes optional — allows project-only retros. |
| `sync_calendar_events` | Upserts into `time_entry` keyed by `external_id`. **Confirmation state survives upsert** (a confirmed row remains confirmed after re-sync). |
| `complete_habit_instance` / `skip_habit_instance` / `generate_habit_instances` | Each habit instance gets a paired `time_entry` (sidecar pattern). `generate_habit_instances` creates UNCONFIRMED entries with `source='habit'`. `complete_habit_instance` confirms its paired entry. `skip_habit_instance` deletes its paired entry. |
| `export_timesheet`, `harvest_push_timesheet`, `get_timesheet_summary` | New `categories: string[]` parameter, default `['work']`. `harvest_push_timesheet` additionally **refuses to push if any UNCONFIRMED entry exists in the range**, with `force: true` override. `get_timesheet_summary` gains optional `include_unconfirmed: boolean` (default `false`). |

### Tools unchanged

`create_task`, `update_task`, `complete_task`, `list_tasks`, `search_tasks`, `create_project`, `update_project`, `list_projects`, `create_category`, `list_categories`, `update_category`, `open_time`, `inbox_*`, `harvest_list_projects`, `get_week_layout`, `get_project_budget`, `get_all_budgets`, `list_availability`, `delete_availability`, `clear_availability`, `list_habits`, `create_habit`.

`complete_task` keeps its task-status-COMPLETE behavior but no longer bumps any hour counter (the column is gone). Logging hours is `log_time` or confirming a placement.

## Skill changes

### `/calendrome:today` — morning brief

List pending entries, then accept **one freeform sentence**. Not a sequential walkthrough.

```
Yesterday has 4 entries waiting for review:
  · A2-151 WebKit hotfix       2.0h placed (09:00–11:00)
  · ATN Internal Meeting       0.5h placed (14:00–14:30)
  · Beehiiv feed (A2-150)      2.0h placed (11:00–13:00)
  · SAN PR review              1.0h placed (15:00–16:00)

How'd yesterday actually go?
```

User: *"4h on the WebKit thing, 5h on beehiiv, skip the meeting, the rest as placed."*

Skill fires in one turn, in parallel:
- `confirm_placement(WebKit, { actual_minutes: 240 })`
- `confirm_placement(beehiiv, { actual_minutes: 300 })`
- `skip_placement(meeting)`
- `confirm_placement(PR review)`

Then reports totals and continues to today's plan.

**Edge cases the skill must handle:**

- "Everything as planned" → `confirm_placement(id)` for all UNCONFIRMED, no amendments
- Partial coverage → for unmentioned entries, **one** follow-up question ("You didn't mention the standup — confirm as-placed or skip?"), not a full sequential walk
- "I also did X not on the list" → `log_time(...)` for the new entry in the same turn

### `/calendrome:today` — end-of-day wrap-up

Same list-then-one-sentence pattern, scoped to today's placements where `start_at < now()`. Catches up the day before bed; tomorrow's morning brief starts fresh.

### `/calendrome:week` — gather step

Same pattern, weekly scope. Lets the user say *"Friday was a wash, skip everything"* or *"Tuesday was actually all Oak help, log 8h on that"* in one sentence. Replaces what #66 would have required as a `reconcile_week` tool.

### `/calendrome:harvest-push` — guardrails

1. **Unconfirmed guard.** Run `list_pending_review` for the push range. If non-empty, refuse and list offenders. User must confirm/skip each one OR pass `force: true`. This guard prevents the failure mode that caused 2026-05-12's silent loss.
2. **Personal preview.** Show "N personal entries excluded by default (use `--include-personal` to override)." Strong separation, visible at the call site.

### `/calendrome:block` — placement + philosophy steer

Creates the gcal event (existing behavior) **and** a paired UNCONFIRMED `time_entry` with `source='placement'`, `external_id=<gcal_event_id>`.

When user phrasing suggests *timer-shaped* ("start a timer for X", "track time on Y until I'm done"), the skill steers per the philosophy:

> *"Want me to set a 45-minute block for this and clear other commitments out of the way? Calendrome's model is placement-first — confirmation tomorrow morning."*

### `/calendrome:onboard` — no change

Skill content unchanged. The schema it writes on first run is the new unified one (handled by Migration §3).

### GUI (read-only) — minimal change

- Budget bars read `v_task_time_spent` instead of `tasks.time_spent_minutes`
- Timeline visual treatment:
  - Future UNCONFIRMED: hatched (existing)
  - **Past UNCONFIRMED (overdue):** new — orange border / warning badge. Visible drift signal without clickable affordances.
  - CONFIRMED: solid (existing)
- **Zero new clickable affordances.** No confirm buttons, no skip buttons. Confirmation is MCP-only via skills.

## Migration

### Step 0 — Pre-migration backfill (operational, before any code change)

Use the current `log_time` tool to fill May 2026 5/4–5/7 gaps so `time_log` is the record we want to preserve. Specifically:

- ~18h ATN beehiiv work (tasks #17/#19/#1; see task notes for per-day breakdowns)
- ~37h SAN WEB-1806 bulk-imported tasks (#52, #53, #54, #68, #69, #70, plus any siblings)
- Any other task with `time_spent_minutes > 0` and no matching `time_log` row in 2026-05-01..2026-05-08

A one-time helper script `scripts/list-may-drift.ts` outputs the list. Walked via the morning-brief one-sentence pattern operating on the old tools (same UX, retroactively). Older months (Jan–Apr) skipped per scope; they will show empty in `time_entry` post-migration.

### Step 1 — Safety net

```bash
cp calendrome.db calendrome.db.bak-pre-time-entry-migration
```

Per the existing pattern (`.bak-pre-april-backfill`, `.bak-pre-notes-migration` already on disk). Rollback = restore the backup.

### Step 2 — Schema migration

The project does not have a numbered-migrations directory; schema lives in `src/db/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`), and idempotent ALTERs run in `src/db/migrate.ts`. Follow that pattern:

1. **Add to `src/db/schema.sql`:** the full `time_entry` table definition (per Data model §), its indexes, the unique partial index on `external_id`, and the `v_task_time_spent` view. All declared with `CREATE … IF NOT EXISTS` (or `CREATE VIEW IF NOT EXISTS`).

2. **Add to `src/db/migrate.ts`:** an idempotent `ALTER TABLE habit_instances ADD COLUMN time_entry_id INTEGER REFERENCES time_entry(id)` guarded by the existing `hasColumn()` helper.

3. **Do not drop legacy tables in this step** — `time_log`, `calendar_events`, `tasks.time_spent_minutes`, `tasks.calendar_event_id` all remain, so the Step 5 parity check has both shapes to compare. They are removed in Step 6.

### Step 3 — Data copy

A one-time TypeScript script `scripts/migrate-to-time-entry.ts` runs the data copy. Wrapped in a single transaction (rolled back on any error). Runs only if `time_log` still exists (i.e., not yet cutover) — idempotent re-runs are a no-op.

```sql
-- Confirmed historical hours
INSERT INTO time_entry (
  task_id, project_id, start_at, end_at, actual_minutes,
  status, confirmed_at, source, harvest_entry_id, notes
)
SELECT
  tl.task_id,
  t.project_id,
  tl.started_at,
  COALESCE(tl.stopped_at, datetime(tl.started_at, '+'||tl.duration_minutes||' minutes')),
  tl.duration_minutes,
  'CONFIRMED',
  COALESCE(tl.stopped_at, tl.started_at),
  'manual',
  tl.harvest_entry_id,
  tl.notes
FROM time_log tl
JOIN tasks t ON t.id = tl.task_id;

-- Future placements (not yet started): UNCONFIRMED, source='placement'
INSERT INTO time_entry (task_id, project_id, start_at, end_at, status, source, is_meeting, external_id, synced_at, notes)
SELECT
  t.id, ce.project_id, ce.start, ce.end,
  'UNCONFIRMED', 'placement', ce.is_meeting, NULL, NULL, NULL
FROM calendar_events ce
LEFT JOIN tasks t ON t.calendar_event_id = ce.id
WHERE ce.start > datetime('now');

-- Gcal-synced events still in the future: UNCONFIRMED, source='gcal-sync'
INSERT INTO time_entry (task_id, project_id, start_at, end_at, status, source, is_meeting, external_id, synced_at, notes)
SELECT
  NULL, ce.project_id, ce.start, ce.end,
  'UNCONFIRMED', 'gcal-sync', ce.is_meeting, ce.id, ce.synced_at, NULL
FROM calendar_events ce
LEFT JOIN tasks t ON t.calendar_event_id = ce.id
WHERE ce.start > datetime('now') AND t.id IS NULL;

-- Past placements: DROPPED, not migrated.
-- Rationale: a past calendar_event placement that never produced a time_log row
-- was the bug source. Guessing its disposition would re-introduce the drift.
-- The Step 0 backfill is the explicit channel for preserving these.

-- Habit instances → paired time_entry rows + sidecar link
-- (Implementation note: insert time_entry rows for each habit_instance row in
-- PLANNED/COMPLETED state, then UPDATE habit_instances SET time_entry_id by
-- joining on (habit_id, scheduled_start). Concrete SQL in implementation plan.)
```

### Step 4 — Code path replacement

Single PR per pre-launch pragmatism (no compat shims):

- `src/time-log.ts` → renamed `src/time-entry.ts`; functions updated
- `src/calendar-sync.ts` → upserts into `time_entry`; preserves confirmation state
- `src/timesheet.ts` → reads `time_entry WHERE status='CONFIRMED'`; joins category for export filter
- `src/budgets.ts` → reads `v_task_time_spent` or direct sum
- `src/tasks.ts` → drops references to removed columns
- `src/habits.ts` → instance lifecycle paired with `time_entry`
- `src/mcp/tools/index.ts` → adds new tools, removes `start_task`/`stop_task`, modifies the seven
- `tests/mcp-tools.test.ts` surface check updated
- GUI (`website/`, `src/gui/`) → reads from new schema and the view
- `website/index.html` (§install) + `website/docs.html` updated per CLAUDE.md "Keep the website in sync"

### Step 5 — Verification

Before dropping legacy tables, run a parity check:

```sql
SELECT 'old' AS source, p.prefix, SUM(tl.duration_minutes)/60.0 AS hours
FROM time_log tl JOIN tasks t ON t.id = tl.task_id JOIN projects p ON p.id = t.project_id
GROUP BY p.prefix
UNION ALL
SELECT 'new', p.prefix, SUM(COALESCE(te.actual_minutes,
  (julianday(te.end_at) - julianday(te.start_at)) * 1440)) / 60.0
FROM time_entry te JOIN projects p ON p.id = te.project_id
WHERE te.status = 'CONFIRMED'
GROUP BY p.prefix;
```

Both shapes must produce identical per-project totals. Halt and investigate if they diverge.

`npm test` must pass against the new shape (with tests updated to write `time_entry`).

### Step 6 — Drop legacy

After Step 5 passes, drop the legacy structures (idempotent — re-runnable):

```sql
DROP TABLE IF EXISTS time_log;
DROP TABLE IF EXISTS calendar_events;
ALTER TABLE tasks DROP COLUMN time_spent_minutes;   -- SQLite ≥ 3.35
ALTER TABLE tasks DROP COLUMN calendar_event_id;    -- SQLite ≥ 3.35
```

Wrap the `ALTER TABLE … DROP COLUMN` calls in idempotent guards (`hasColumn()` check first), since SQLite errors if the column is already gone. Add the corresponding removals to `src/db/schema.sql` so a fresh install doesn't recreate them.

### Step 7 — Cutover commit

Single PR. Suggested title: `feat: unify time_log + calendar_events + time_spent_minutes into time_entry (closes #44, supersedes #66)`. Includes schema migration, code replacement, test updates, GUI updates, and website install-docs sync per CLAUDE.md.

## Tests

The existing 110+ vitest suite must pass post-migration. Tests writing directly to `time_log` / `calendar_events` are rewritten to write `time_entry`. Net new coverage:

| Area | Test |
|---|---|
| **State machine** | UNCONFIRMED → CONFIRMED via `confirm_placement` writes `confirmed_at`; CONFIRMED cannot transition back; CONFIRMED entries immutable except for `notes` |
| **Confirm semantics** | Confirm as-placed uses `end_at − start_at`; `actual_minutes` override stored; `project_id` override reassigns |
| **Skip** | Deletes the row; rejects on CONFIRMED; rejects on `source='gcal-sync'` |
| **list_pending_review** | Returns only `status='UNCONFIRMED' AND start_at < now()`; respects `category` filter (defaults `'work'`); future placements never appear |
| **move_placement** | Preserves duration by default; accepts `new_end_at`; rejects on CONFIRMED, on `source='gcal-sync'`, on `source='manual'` |
| **Export filter** | `export_timesheet` defaults to `categories=['work']`; personal excluded by default; `['work','personal']` includes both; `['personal']` personal-only |
| **Harvest guard** | `harvest_push_timesheet` refuses if any UNCONFIRMED in range; lists offenders; `force: true` overrides |
| **gcal upsert** | Confirming a `source='gcal-sync'` entry, then re-syncing the same gcal event, does **not** un-confirm it |
| **View parity** | `v_task_time_spent` per-task sums equal direct `SUM(...) WHERE status='CONFIRMED'` queries |
| **Habit sidecar** | `generate_habit_instances` creates paired rows; `complete_habit_instance` confirms paired; `skip_habit_instance` deletes paired; `habit_instances.time_entry_id` stays in lockstep |
| **log_time** | Inserts CONFIRMED; `task_id` optional; rejects inverted or far-future timestamps |
| **Migration parity** | `tests/migration-006.test.ts` — load seeded fixture (`time_log` + `calendar_events` + `tasks.time_spent_minutes`), run migration, assert per-project totals match before vs. after |
| **MCP surface check** | `tests/mcp-tools.test.ts` — `start_task` / `stop_task` absent; `confirm_placement` / `skip_placement` / `list_pending_review` / `move_placement` present |

The migration-parity test is the load-bearing one. If red, no merge.

## Open questions

None at draft. Spec is ready for implementation-plan handoff.

## Decisions log (during brainstorm)

1. **Scope** — #44 + #66 unified (option B). #66 collapses into the design with no separate tool.
2. **Three stores → one** — `time_entry` with two states. `tasks.time_spent_minutes` becomes a view.
3. **Personal/work separation** — handled by existing `category` model. New filter at export boundary (`categories=['work']` default).
4. **Habits + gcal-sync** — both collapse into `time_entry`. `habit_instances` keeps recurrence logic as a sidecar.
5. **Live stopwatch** — dropped. `start_task` / `stop_task` removed.
6. **Migration** — preserve `time_log` historical hours (option B). May-only backfill pre-migration. Drop past placements at migration time. Wipe-and-rebuild for everything else, per pre-launch pragmatism.
7. **Brief UX** — list pending entries + accept one freeform sentence. No sequential confirmation walk. (Honors the "claiming and releasing time should be one sentence" principle in CLAUDE.md.)
8. **`move_placement`** — added to MCP surface. Cascade ("slide everything else") deferred to a future issue.

## References

- CLAUDE.md (`/Users/matthausklute/dev/tools/calendrome/CLAUDE.md`) — three principles, three-table architecture
- Issue [#44](https://github.com/mklute101/calendrome/issues/44) — original placement-confirmation proposal (this spec implements + extends)
- Issue [#66](https://github.com/mklute101/calendrome/issues/66) — week reconciliation (this spec supersedes)
- Issue [#46](https://github.com/mklute101/calendrome/issues/46) (closed) — `log_time` foreshadowed shared writer with `confirm_placement`
- Issue [#30](https://github.com/mklute101/calendrome/issues/30) (closed) — original `calendar_events` design; preserved capabilities listed above
- Brainstorm session — 2026-05-13, conversation transcript covering scope, data model, MCP surface, skill changes, migration, tests, out-of-scope
