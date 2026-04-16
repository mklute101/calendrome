# Reclaim ↔ Google Calendar ↔ Calendrome: Field Mapping

A reference for understanding how a Reclaim.ai task becomes a Google
Calendar event, and how the calendrome equivalent (a task + a
`place_task` call) produces the same shape on your calendar.

No code here — this is purely a translation table for reasoning about the
data.

---

## The three shapes, side by side

### 1. Reclaim task (what Reclaim stores internally, returned by `/tasks`)

```json
{
  "id": 12345,
  "title": "ACME: Write quarterly report",
  "notes": "Focus on revenue split",
  "eventCategory": "WORK",
  "status": "NEW",
  "priority": "P2",
  "timeChunksRequired": 8,
  "minChunkSize": 2,
  "maxChunkSize": 8,
  "due": "2026-04-30T17:00:00Z",
  "snoozeUntil": null,
  "alwaysPrivate": false,
  "timeSchemeId": "work-hours-default",
  "created": "2026-04-10T14:22:11Z"
}
```

A Reclaim task is a **recipe** for calendar events. Reclaim decides when
to place it based on `priority`, `due`, and the time scheme (work/personal
hours). It can split one task across multiple events (chunking) bounded
by `minChunkSize` and `maxChunkSize`.

### 2. Google Calendar event (what Reclaim writes when it schedules the task)

```json
{
  "id": "abc123xyz456",
  "summary": "ACME: Write quarterly report",
  "description": "Focus on revenue split\n\nReclaim Task: https://app.reclaim.ai/tasks/12345",
  "start": { "dateTime": "2026-04-22T09:00:00-05:00", "timeZone": "America/Chicago" },
  "end":   { "dateTime": "2026-04-22T11:00:00-05:00", "timeZone": "America/Chicago" },
  "colorId": "5",
  "visibility": "default",
  "transparency": "opaque",
  "extendedProperties": {
    "private": {
      "reclaim.taskId": "12345",
      "reclaim.chunkIndex": "1",
      "reclaim.chunkCount": "4"
    }
  },
  "source": {
    "title": "Reclaim.ai",
    "url": "https://app.reclaim.ai/tasks/12345"
  }
}
```

Key things Reclaim does with the event:
- The `summary` is the task title verbatim.
- The `description` embeds a backlink so the event can be un-scheduled by
  clicking through to Reclaim.
- `extendedProperties.private.reclaim.taskId` tags the event so Reclaim
  can find-and-update it later (e.g. when you reschedule or drag it).
- For an 8-chunk (2h) task, Reclaim may emit 4 events of 2 chunks each
  (30 min), each with a distinct `chunkIndex`. That's how it "chunks."

### 3. Calendrome equivalent

**Create the task:**
```json
// create_task
{
  "project_id": "acme",
  "title": "Write quarterly report",
  "notes": "Focus on revenue split",
  "priority": "HIGH",
  "duration_minutes": 120,
  "due": "2026-04-30T17:00:00Z"
}
```

**Place it on the calendar** (you or the planner skill decide the time):
```json
// place_task
{
  "task_id": 42,
  "start": "2026-04-22T14:00:00Z"
}
```

**Resulting Google Calendar event** (what `FakeCalendarClient` records and
what `GoogleCalendarClient` will write in Phase 2):
```json
{
  "id": "evt-1",
  "calendar_id": "cal-acme",
  "summary": "ACME Write quarterly report",
  "start": "2026-04-22T14:00:00Z",
  "end":   "2026-04-22T16:00:00Z",
  "description": "Focus on revenue split"
}
```

Calendrome's event is deliberately simpler than Reclaim's: **one task →
one event, one time.** Chunking, auto-placement, and rescheduling-on-
conflict are handled upstream by the daily/weekly planner skills
(collaborative with you), not by the engine.

---

## Field-by-field mapping

| Concept | Reclaim task field | Google Calendar event field | Calendrome task field | Calendrome event field (via `place_task`) |
|---|---|---|---|---|
| **ID** | `id` (int) | `id` (string, Google-assigned) | `id` (int, autoincrement) | `calendar_event_id` (string) |
| **Title** | `title` | `summary` | `title` | `summary` = `${project.prefix} ${task.title}` |
| **Description / notes** | `notes` | `description` (+ Reclaim backlink) | `notes` | `description` = `notes` (no backlink) |
| **Category / bucket** | `eventCategory`: `WORK` \| `PERSONAL` | `colorId` (Reclaim picks by category) | `project_id` → project row | `calendar_id` on the event (from `project.calendar_id`) |
| **Priority** | `priority`: `P1`..`P4` | — (not on event) | `priority`: `CRITICAL` \| `HIGH` \| `MEDIUM` \| `LOW` | — (not on event) |
| **Status** | `status`: `NEW` \| `SCHEDULED` \| `IN_PROGRESS` \| `COMPLETE` \| `ARCHIVED` | — (event existence implies scheduled) | `status`: same enum | — (event existence implies SCHEDULED) |
| **Duration** | `timeChunksRequired` × 15 min | `end` − `start` | `duration_minutes` | `end` = `start` + `duration_minutes` |
| **Chunk bounds** | `minChunkSize`, `maxChunkSize` (15-min chunks) | Reflected across multiple events | *(not modeled — no chunking)* | *(not modeled)* |
| **Due date** | `due` (ISO 8601) | — (Google events have no "due") | `due` (ISO 8601) | — (not projected onto event) |
| **Snooze / defer** | `snoozeUntil` | — | `snooze_until` | — |
| **Time window policy** | `timeSchemeId` → hours scheme | — | project `time_policies` rows | — (planner consults policy, event carries nothing) |
| **Privacy** | `alwaysPrivate`: bool | `visibility`: `default` \| `private` | *(not modeled)* | *(defaults to calendar default)* |
| **Backlink to source** | — | `description` contains Reclaim URL; `source.url`; `extendedProperties.private.reclaim.taskId` | — | `calendar_event_id` stored on task; no URL embedded in event |
| **Event identity for re-sync** | `extendedProperties.private.reclaim.taskId` on every chunk | same | `tasks.calendar_event_id` (1:1) | `calendar_event_id` on the event row in calendrome |
| **Start time** | — (Reclaim picks) | `start.dateTime` + `timeZone` | — (you/planner pick) | `start` (ISO 8601, UTC) |
| **Time tracking** | `/planner/start/task/{id}` / `/planner/stop/task/{id}` | — | `startTask` / `stopTask` → `time_log` rows | — (actual time is separate from the scheduled block) |

---

## Key conceptual differences

1. **Reclaim schedules; calendrome doesn't.** Reclaim decides *when* based
   on priority, due date, and time scheme. Calendrome only decides *what's
   available to be scheduled* — you (via the planner skills) decide when.
   Everything in Reclaim's "Scheduling Algorithm" lives in a planner
   skill conversation, not in code.

2. **Reclaim can produce many events per task; calendrome produces one.**
   If you need a long task split across the week, you create multiple
   shorter tasks (or the planner skill creates them for you). This is a
   deliberate simplification — chunking-with-re-chunking-on-conflict is
   the part of Reclaim that's hardest to reason about.

3. **Reclaim embeds a backlink in the event description; calendrome
   doesn't.** Instead, calendrome stores `calendar_event_id` on the task
   and considers the event write-only from the calendar's perspective.
   If you delete the event in Google Calendar, calendrome's state will
   drift — the task will still show `calendar_event_id` set. Phase 2
   will need a light reconcile step (or a hard rule: "don't edit
   calendrome events from Google Calendar").

4. **Reclaim uses `eventCategory` (WORK/PERSONAL); calendrome uses
   `project_id`.** A project's `calendar_id` decides which Google
   Calendar the event lands on, so project-level sharing is one GCal
   share, not a filter.

5. **Priority is an input, not an event property.** Neither system writes
   priority onto the calendar event. In Reclaim it biases placement; in
   calendrome it biases what the planner skill suggests you work on
   next.

---

## If you're comparing a real Reclaim event in your calendar

Open any auto-scheduled Reclaim block, expand "Event details" → "Source,"
and you should see the Reclaim URL. The underlying event JSON via
`GET /calendar/v3/calendars/primary/events/{eventId}` will include the
`extendedProperties.private.reclaim.*` keys above. That's how Reclaim
knows it "owns" the event — useful if you ever want to script a cleanup
or an "archive all Reclaim events" pass during migration to calendrome.
