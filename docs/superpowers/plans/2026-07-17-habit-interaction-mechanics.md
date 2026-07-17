# Habit interaction mechanics (#103, Option C) — implementation plan

**Date:** 2026-07-17
**Status:** Ready to implement — this branch is the implementation track
**Implements:** [#103](https://github.com/mklute101/calendrome/issues/103) under the **current** habit model
**Parallel track:** [#106](https://github.com/mklute101/calendrome/issues/106) / PR #107 explore a
first-principles redesign (commitment taxonomy). This plan deliberately
implements #103 as originally scoped — Option C on today's model — so the
two approaches can be run and compared side by side.

**Model:** habit *instances* get complete / skip / move-just-this-one /
detach-to-one-off, surfaced in both MCP and GUI; the habit *template* gets a
small MCP-only management surface (`update_habit` / `deactivate_habit`).
Template editing stays conversational per CLAUDE.md; the GUI only touches
instances.

---

## Design decisions

### D1. Move/snooze-just-this-one: `scheduled_start` is immutable slot identity

Do NOT back-propagate moves into `habit_instances.scheduled_start`. Redefine
`scheduled_start` as the instance's *canonical slot identity*; the linked
`time_entry.start_at/end_at` is where the block actually sits.

Why: `generateHabitInstances` (src/habits.ts:221-225) dedupes via
`INSERT OR IGNORE` keyed on `UNIQUE(habit_id, scheduled_start)`, and
`buildWeekPayload` regenerates on every `/api/week` request
(src/gui/week-data.ts:44-51). If a move rewrote `scheduled_start`, the vacated
canonical slot would be regenerated as a fresh duplicate instance on the next
poll. Keeping it immutable sidesteps UNIQUE collisions entirely and turns the
existing "desync" (moving a habit-sourced entry via `move_placement` never
touched the instance) into a defined contract: slot identity vs. planned time.

New core fn `moveHabitInstance(db, id, new_start, { new_end? })`, in a
transaction:
- load instance; throw if not found; throw unless `status === 'PLANNED'`;
  throw if `time_entry_id IS NULL`
- `moveTimeEntry(db, time_entry_id, new_start, { new_end_at })` — existing
  guards + `toCanonicalUtc` come free
- return the instance joined with the refreshed entry

GUI drag of a habit block routes to `/api/habit-instances/:id/move`, NOT
`/api/placements/:id/move` — the client-facing id is the instance id and the
endpoint enforces the PLANNED-only guard.

### D2. Detach-to-one-off: convert the linked entry in place

`detachHabitInstance(db, id)` — transaction:
1. Load instance + habit; require `status='PLANNED'` and `time_entry_id`
   non-NULL.
2. `createTask(db, { project_id: habit.project_id, title: habit.title,
   notes: habit.notes, duration_minutes: <derived from the entry's current
   span> })`, then `setTaskStatus(db, taskId, 'SCHEDULED')` (NEW→SCHEDULED is
   in `ALLOWED_TRANSITIONS`, src/tasks.ts:46).
3. `UPDATE time_entry SET source='placement', task_id=?,
   updated_at=datetime('now') WHERE id=?` — reuse the existing row so a prior
   move is preserved; `source='placement'` passes the CHECK constraint
   (schema.sql:112). The week-data placements query (JOIN tasks ON
   te.task_id, source='placement', status='UNCONFIRMED') then renders it as a
   normal interactive placement with no further work.
4. `UPDATE habit_instances SET status='DETACHED', time_entry_id=NULL
   WHERE id=?` — free-text status is schema-legal (no CHECK on
   habit_instances.status). The DETACHED row keeps occupying its UNIQUE slot,
   so regeneration never recreates the block.
5. Return `{ instance, task, time_entry_id }`.

No calendar event is created (`external_id` stays NULL — `unplaceTask`
tolerates that; `LocalCalendarClient` is the production default). Undo
semantics: none in v1 — recovery is conversational (archive the task; the
DETACHED instance blocks regeneration so no duplicate appears). The GUI
detach toast has no `undo` callback.

### D3. `deactivate_habit` + future-instance cleanup; `update_habit` cleans on schedule changes

MCP tool is `deactivate_habit` (matches PLAN.md:218; hard delete is blocked
by the `habit_instances.habit_id` FK anyway). Extend `deactivateHabit(db,
id)` to a transaction:
- `UPDATE habits SET active=0`
- delete future not-yet-actioned instances: delete `time_entry` rows linked
  from `habit_instances WHERE habit_id=? AND status='PLANNED' AND
  scheduled_start >= <canonical UTC now>`, then those instance rows. Past
  PLANNED instances are kept (pending-review history); COMPLETE / SKIPPED /
  DETACHED are kept.
- return `{ habit, removed_instances: n }`

**Prerequisite fix (load-bearing):** `buildWeekPayload` calls `listHabits(db)`
with no filter (week-data.ts:44) — it regenerates instances for deactivated
habits, silently undoing cleanup on the next poll. Change to
`listHabits(db, { active: true })`. Also add an `active` check + error in
`generate_habit_instances` for consistency.

**`update_habit`:** patch-object tool mirroring `update_task`
(src/mcp/tools/index.ts:273-293) over the existing `updateHabit`
(src/habits.ts:155-172, currently untested and unexposed). Exclude `active`
from the MCP schema (deactivation must go through `deactivate_habit` so
cleanup runs). Extend core `updateHabit`: when a schedule-shaping field
changes (`start_time`, `days_of_week`, `duration_minutes`, `timezone`), run
the same future-PLANNED purge in the transaction — the next `/api/week` or
`generate_habit_instances` call lazily regenerates under the new parameters.
On `title` change, `UPDATE time_entry SET notes=? ` for linked UNCONFIRMED
instances so existing blocks re-label. Reject an empty patch.

### D4. GUI affordances on habit blocks

- **✓ complete / ✕ skip** buttons in a `.block-actions` div, exactly
  mirroring the placement block (WeekTimeline.tsx:159-177), shown only when
  `status === 'PLANNED'`.
- **Detach** as a third small button (`⤓`, title "Detach — turn this
  occurrence into a one-off task").
- **Drag body to move** (new `move-habit` drag kind); **no resize handle** —
  instance duration comes from the template (`moveHabitInstance` accepts
  `new_end` for future use).
- **Overdue cue:** `isOverdueHabit(hi)` = `status==='PLANNED' &&
  Date.parse(start) < now`, reusing the existing `.overdue-review` class.
- **Status rendering:** PLANNED as today; COMPLETE dimmed with ✓ prefix
  (new `.timeline-block.habit.complete`); SKIPPED and DETACHED not rendered
  as habit blocks (DETACHED renders as its placement; filter in `buildDays`
  so Compact view inherits it).
- **Undo for skip/complete toasts:** new `reopenHabitInstance` core fn +
  GUI-only endpoint (precedent: `reopenTask`, src/gui/mutations.ts:92-117 —
  documented GUI-undo-only deviation). From SKIPPED: status→PLANNED,
  re-insert the UNCONFIRMED entry at `scheduled_start/scheduled_end`, relink.
  From COMPLETE: status→PLANNED, `completed_at=NULL`, unconfirm the linked
  entry (`status='UNCONFIRMED', confirmed_at=NULL` — validated to only run
  against a habit-sourced entry). No MCP tool for reopen (matches
  reopenTask).
- Template edit/deactivate: **no GUI surface**.

### D5. Pending review coherence

With ✓/✕ + the overdue cue on habit blocks, habit-sourced UNCONFIRMED
entries become reachable in the GUI via the instance flow — sufficient per
the issue. Hardening for the MCP path: `list_pending_review` already returns
habit entries, but `confirm_placement`/`skip_placement` on them today leaves
the instance desynced (confirm leaves it PLANNED; skip deletes the row
leaving a dangling `time_entry_id`). Add back-sync inside `confirmTimeEntry`
and `skipTimeEntry` (src/time-entry.ts) via raw SQL
(`UPDATE habit_instances SET status='COMPLETE', completed_at=... WHERE
time_entry_id = ?` resp. `status='SKIPPED', time_entry_id=NULL`) — raw SQL
avoids a habits.ts import cycle, and both directions converge on the same
end state.

## Step-by-step implementation

### Phase 1 — core fns + tests (`src/habits.ts`, `src/time-entry.ts`)

1. `src/habits.ts`: widen `HabitInstance['status']` to
   `'PLANNED' | 'COMPLETE' | 'SKIPPED' | 'DETACHED'`; add
   `moveHabitInstance` (D1), `detachHabitInstance` (D2),
   `reopenHabitInstance` (D4); extend `deactivateHabit` (D3, returns
   `{habit, removed_instances}`) and `updateHabit` (D3). All multi-row
   writes inside `db.transaction`.
2. `src/time-entry.ts`: habit back-sync in `confirmTimeEntry`/`skipTimeEntry`
   (D5).
3. `tests/habits.test.ts` (uses `freshDb()` + `createProject`): `updateHabit`
   basic patch (currently untested); schedule-change purges future PLANNED
   instances + entries but keeps past/COMPLETE/SKIPPED; deactivate cleanup
   ditto; move updates the linked entry, leaves `scheduled_start` untouched,
   refuses non-PLANNED and missing-entry; regeneration after a move creates
   no duplicate; detach creates a SCHEDULED task, converts the entry, NULLs
   `time_entry_id`, marks DETACHED, and regeneration creates no duplicate;
   reopen from SKIPPED recreates the entry, from COMPLETE unconfirms it.
4. `tests/time-entry.test.ts`: confirm/skip of a habit-sourced entry flips
   the instance.

### Phase 2 — week payload (`src/gui/week-data.ts`)

5. `listHabits(db)` → `listHabits(db, { active: true })` (load-bearing for
   D3).
6. Habit-instance query: `LEFT JOIN time_entry te ON te.id =
   hi.time_entry_id`; add `COALESCE(te.start_at, hi.scheduled_start) AS
   start_at`, `COALESCE(te.end_at, hi.scheduled_end) AS end_at`; range-filter
   and ORDER on the coalesced start so moved instances bucket on the day they
   now occupy.
7. `tests/gui-week-data.test.ts`: moved instance surfaces with the entry's
   start; deactivated habit stops producing instances; detached instance
   appears in `placements` and its habit row carries `status='DETACHED'`.

### Phase 3 — MCP tools (`src/mcp/tools/index.ts`)

8. Import the new/existing core fns; append to the habits section (after
   ~line 541), each with a JSDoc block in the `create_task` canonical shape
   (the docs extractor walks `buildTools`, so `/docs` and the website update
   automatically):
   - `update_habit` — `{id, title?, notes?, duration_minutes?,
     days_of_week?, start_time?, timezone?}`; document future-instance
     regeneration.
   - `deactivate_habit` — `{id}`; document soft-delete + future-PLANNED
     cleanup.
   - `move_habit_instance` — `{id, new_start, new_end?}`; document
     snooze-one-occurrence semantics.
   - `detach_habit_instance` — `{id}`; document task creation + entry
     conversion.
   - Update the `move_placement` JSDoc to point habit moves at
     `move_habit_instance`.
9. `tests/mcp-tools.test.ts`: add the four names to the surface list
   (lines 29-72); add a handler round-trip test.

### Phase 4 — GUI server (`src/gui/mutations.ts`, `src/gui/server.ts`)

10. `mutations.ts`: `guiHabitComplete`, `guiHabitSkip`, `guiHabitMove`,
    `guiHabitDetach`, `guiHabitReopen` — thin wrappers returning the
    refreshed instance (join the entry for `start_at/end_at` so optimistic
    reconcile works).
11. `server.ts`: `POST /api/habit-instances/:id/{complete,skip,move,detach,
    reopen}` using the existing `mutate`/`idParam` helpers, JSDoc'd. `move`
    body `{start, end?}` validated like `/api/placements/:id/move`; `reopen`
    documented as the GUI-undo deviation.
12. Tests: `gui-mutations.test.ts` per-wrapper (guards → thrown errors);
    `gui-http.test.ts` happy chain (generate → move → complete → reopen →
    skip), 404/409 mapping, Origin-guard smoke on the new paths.

### Phase 5 — GUI client (`src/gui/app/…`)

13. `types.ts`: extend `HabitInstance` with `scheduled_end`, `start_at`,
    `end_at`, `status`, `time_entry_id: number | null`,
    `completed_at: string | null` (the server payload already carries them —
    `SELECT hi.*`).
14. `api.ts`: one-line `post` wrappers for the five endpoints.
15. `lib/weekdays.ts`: bucket habits by `hi.start_at.slice(0,10)`; drop
    SKIPPED/DETACHED (keep COMPLETE in `totalMin` — it's still time spent);
    `findOverlap` uses `start_at`, PLANNED-only; add `isOverdueHabit`.
16. `hooks/useTimelineDrag.ts`: add `{ kind: 'move-habit'; instance:
    HabitInstance; color }` to `DragSource`; generalize label/duration/
    blockRect branches.
17. `WeekTimeline.tsx`: habit block gets `onPointerDown` → `move-habit` drag
    (PLANNED only), `.block-actions` with ✓/✕/⤓ (PLANNED only),
    `overdue-review`/`complete` classes; new props
    `onCompleteHabit/onSkipHabit/onDetachHabit`.
18. `WeekView.tsx`: handlers via `runMutation` + toasts — complete (undo →
    reopen), skip (undo → reopen), detach (no undo, "Detached — now a
    one-off task"); `onDrop` `move-habit` branch: optimistic `applyLocal` on
    `habit_instances` `start_at/end_at`, POST move, undo = move back,
    `warnOverlap` reuse.
19. `styles.css`: `.timeline-block.habit.complete` (+ compact variant).

### Phase 6 — verification + record-keeping

20. `npm test`; `npm run build` (confirms the docs extractor parses the new
    tool + server JSDoc); optional `e2e/habit-drag.spec.ts` mirroring
    `e2e/drag.spec.ts` (seed habit + generate, drag the habit block, assert
    the linked `time_entry` moved and `scheduled_start` didn't).
21. Docs: no manual website sync needed (`website/docs.html` renders
    `docs.json`, regenerated at build). PLAN.md:218 already names
    `update_habit`/`deactivate_habit`; add `move_habit_instance` /
    `detach_habit_instance` to the habits row while touching it.
22. Comment on #103 when the surface lands, checking off its checkboxes.

### Sequencing

Phases are strictly ordered (core → payload → MCP → GUI server → GUI client
→ e2e); each phase leaves `npm test` green. The week-data `active:true` fix
(step 5) must land with or before `deactivate_habit` (step 8) or
deactivation visibly self-reverts.
