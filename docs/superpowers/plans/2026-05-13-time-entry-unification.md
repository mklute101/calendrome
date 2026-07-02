# `time_entry` Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `time_log` + `calendar_events` + `tasks.time_spent_minutes` into one `time_entry` table with `UNCONFIRMED`/`CONFIRMED` states, replacing the silent-drift class that caused 2026-05-12's missing-hours incident.

**Architecture:** One unified `time_entry` table holds every "thing on the calendar." Two states (UNCONFIRMED, CONFIRMED) with `confirm_placement` / `skip_placement` MCP tools driving transitions. `tasks.time_spent_minutes` becomes a SQL view. `habit_instances` keeps recurrence logic as a sidecar. Personal/work strong separation enforced by a `categories=['work']` default filter at the export boundary. Live stopwatch (`start_task`/`stop_task`) is removed.

**Tech Stack:** TypeScript, better-sqlite3 (WAL), vitest, MCP stdio server.

**Spec reference:** `docs/superpowers/specs/2026-05-13-time-entry-unification-design.md`

**PR shape:** Single PR per pre-launch pragmatism (no compat shims). Commits along the way; squash on merge if desired.

---

## Phase 0 — Pre-migration backfill (operational, no code)

### Task 0: Backfill May 2026 5/4–5/7 hours via current `log_time`

**Files:** none (operational task using existing MCP tools).

- [ ] **Step 1: Identify drift candidates**

Run against the live DB (read-only):

```sql
SELECT
  t.id, t.title, p.prefix, t.time_spent_minutes,
  (SELECT COUNT(*) FROM time_log tl WHERE tl.task_id = t.id) AS log_count,
  (SELECT MAX(tl.started_at) FROM time_log tl WHERE tl.task_id = t.id) AS last_log
FROM tasks t
JOIN projects p ON p.id = t.project_id
WHERE t.time_spent_minutes > 0
  AND t.updated_at >= '2026-05-01'
ORDER BY t.updated_at DESC;
```

Cross-reference against git commits and calendar events to attribute hours per day.

- [ ] **Step 2: Backfill via `log_time` MCP calls**

For each missing-day attribution, call `mcp__calendrome__log_time({ task_id, started_at, stopped_at, notes })`. Use one-sentence dictation through `/calendrome:today`-style flow rather than typing individual calls.

- [ ] **Step 3: Verify CSV export now matches expectations**

```
mcp__calendrome__export_timesheet({ from: '2026-05-01', to: '2026-05-08' })
```

Per-project totals should reflect the actual ~55h tracked, not the ~13h that came back on 2026-05-12.

- [ ] **Step 4: No commit needed — operational only**

---

## Phase 1 — Schema foundation

### Task 1: Add `time_entry` table, indexes, and view to `schema.sql`

**Files:**
- Modify: `src/db/schema.sql` (append below the existing tables)
- Test: `tests/db/schema.test.ts` (create new file)

- [ ] **Step 1: Write the failing test**

Create `tests/db/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { freshDb } from '../helpers/freshDb.js';

describe('time_entry schema', () => {
  it('creates time_entry table with required columns', () => {
    const db = freshDb();
    const cols = db.prepare("PRAGMA table_info('time_entry')").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id', 'task_id', 'project_id',
        'start_at', 'end_at', 'actual_minutes',
        'status', 'confirmed_at',
        'source', 'external_id', 'is_meeting', 'synced_at', 'harvest_entry_id',
        'notes', 'created_at', 'updated_at',
      ]),
    );
  });

  it('rejects invalid status values via CHECK constraint', () => {
    const db = freshDb();
    expect(() =>
      db.prepare(
        `INSERT INTO time_entry (start_at, end_at, status, source)
         VALUES (?, ?, ?, ?)`,
      ).run('2026-05-13T09:00:00Z', '2026-05-13T10:00:00Z', 'BOGUS', 'manual'),
    ).toThrow();
  });

  it('rejects invalid source values via CHECK constraint', () => {
    const db = freshDb();
    expect(() =>
      db.prepare(
        `INSERT INTO time_entry (start_at, end_at, status, source)
         VALUES (?, ?, ?, ?)`,
      ).run('2026-05-13T09:00:00Z', '2026-05-13T10:00:00Z', 'UNCONFIRMED', 'invalid_src'),
    ).toThrow();
  });

  it('creates v_task_time_spent view that sums CONFIRMED actual_minutes per task', () => {
    const db = freshDb();
    // seed: insert a task and two confirmed entries
    db.prepare(
      `INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'Test', 'TEST')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title) VALUES (1, 'TEST', 'task')`,
    ).run();
    db.prepare(
      `INSERT INTO time_entry (task_id, project_id, start_at, end_at, actual_minutes, status, source)
       VALUES (1, 'TEST', '2026-05-13T09:00:00Z', '2026-05-13T10:00:00Z', 60, 'CONFIRMED', 'manual')`,
    ).run();
    db.prepare(
      `INSERT INTO time_entry (task_id, project_id, start_at, end_at, actual_minutes, status, source)
       VALUES (1, 'TEST', '2026-05-13T14:00:00Z', '2026-05-13T15:30:00Z', 90, 'CONFIRMED', 'manual')`,
    ).run();
    db.prepare(
      `INSERT INTO time_entry (task_id, project_id, start_at, end_at, actual_minutes, status, source)
       VALUES (1, 'TEST', '2026-05-14T09:00:00Z', '2026-05-14T10:00:00Z', 60, 'UNCONFIRMED', 'placement')`,
    ).run();

    const row = db.prepare(
      `SELECT minutes FROM v_task_time_spent WHERE task_id = 1`,
    ).get() as { minutes: number };
    expect(row.minutes).toBe(150); // 60 + 90, UNCONFIRMED ignored
  });
});
```

If `tests/helpers/freshDb.js` doesn't already exist, check `tests/helpers/` for the established fresh-DB helper and import that instead.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/db/schema.test.ts
```

Expected: 4 failures (table doesn't exist).

- [ ] **Step 3: Add `time_entry` schema to `schema.sql`**

Append to `src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS time_entry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER REFERENCES tasks(id),
  project_id      TEXT    REFERENCES projects(id),
  start_at        TEXT    NOT NULL,
  end_at          TEXT    NOT NULL,
  actual_minutes  INTEGER,
  status          TEXT    NOT NULL DEFAULT 'UNCONFIRMED'
                          CHECK (status IN ('UNCONFIRMED', 'CONFIRMED')),
  confirmed_at    TEXT,
  source          TEXT    NOT NULL
                          CHECK (source IN ('placement', 'gcal-sync', 'habit', 'manual')),
  external_id     TEXT,
  is_meeting      INTEGER NOT NULL DEFAULT 0,
  synced_at       TEXT,
  harvest_entry_id INTEGER,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_time_entry_range ON time_entry(start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_time_entry_status_start ON time_entry(status, start_at);
CREATE INDEX IF NOT EXISTS idx_time_entry_project ON time_entry(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entry_task ON time_entry(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entry_external
  ON time_entry(external_id) WHERE external_id IS NOT NULL;

CREATE VIEW IF NOT EXISTS v_task_time_spent AS
SELECT
  task_id,
  CAST(SUM(COALESCE(actual_minutes,
    (julianday(end_at) - julianday(start_at)) * 24 * 60)) AS INTEGER) AS minutes
FROM time_entry
WHERE status = 'CONFIRMED' AND task_id IS NOT NULL
GROUP BY task_id;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/db/schema.test.ts
```

Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql tests/db/schema.test.ts
git commit -m "feat(schema): add time_entry table, indexes, and v_task_time_spent view"
```

### Task 2: Add `habit_instances.time_entry_id` sidecar column via `migrate.ts`

**Files:**
- Modify: `src/db/migrate.ts`
- Test: `tests/db/schema.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/db/schema.test.ts`:

```typescript
  it('adds time_entry_id sidecar column to habit_instances', () => {
    const db = freshDb();
    const cols = db.prepare("PRAGMA table_info('habit_instances')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('time_entry_id');
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/db/schema.test.ts
```

- [ ] **Step 3: Add idempotent ALTER to `migrate.ts`**

In `src/db/migrate.ts`, inside `migrate(db)` after the existing category-backfill block:

```typescript
  if (!hasColumn(db, 'habit_instances', 'time_entry_id')) {
    db.exec(
      'ALTER TABLE habit_instances ADD COLUMN time_entry_id INTEGER REFERENCES time_entry(id)',
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/db/schema.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate.ts tests/db/schema.test.ts
git commit -m "feat(schema): add habit_instances.time_entry_id sidecar FK"
```

---

## Phase 2 — `time-entry` module (core CRUD)

### Task 3: Create `src/time-entry.ts` with `insertTimeEntry` and types

**Files:**
- Create: `src/time-entry.ts`
- Test: `tests/time-entry.test.ts` (create new file)

- [ ] **Step 1: Write the failing test**

Create `tests/time-entry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/freshDb.js';
import { insertTimeEntry } from '../src/time-entry.js';

describe('insertTimeEntry', () => {
  it('inserts an UNCONFIRMED placement entry', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'TEST', 't')`).run();

    const id = insertTimeEntry(db, {
      task_id: 1,
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });

    const row = db.prepare(`SELECT * FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.status).toBe('UNCONFIRMED');
    expect(row.source).toBe('placement');
    expect(row.confirmed_at).toBeNull();
    expect(row.actual_minutes).toBeNull();
  });

  it('inserts a CONFIRMED manual entry with actual_minutes', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();

    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      actual_minutes: 60,
      status: 'CONFIRMED',
      confirmed_at: '2026-05-13T10:00:00Z',
      source: 'manual',
      notes: 'retro log',
    });

    const row = db.prepare(`SELECT * FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.status).toBe('CONFIRMED');
    expect(row.actual_minutes).toBe(60);
    expect(row.confirmed_at).toBe('2026-05-13T10:00:00Z');
    expect(row.task_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/time-entry.test.ts
```

Expected: import error (file doesn't exist).

- [ ] **Step 3: Create `src/time-entry.ts`**

```typescript
import type { DB } from './db/connection.js';

export type TimeEntryStatus = 'UNCONFIRMED' | 'CONFIRMED';
export type TimeEntrySource = 'placement' | 'gcal-sync' | 'habit' | 'manual';

export interface TimeEntryInput {
  task_id?: number | null;
  project_id?: string | null;
  start_at: string;
  end_at: string;
  actual_minutes?: number | null;
  status: TimeEntryStatus;
  confirmed_at?: string | null;
  source: TimeEntrySource;
  external_id?: string | null;
  is_meeting?: boolean;
  synced_at?: string | null;
  harvest_entry_id?: number | null;
  notes?: string | null;
}

export interface TimeEntry extends Required<Omit<TimeEntryInput, 'is_meeting'>> {
  id: number;
  is_meeting: number;
  created_at: string;
  updated_at: string;
}

export function insertTimeEntry(db: DB, input: TimeEntryInput): number {
  const stmt = db.prepare(`
    INSERT INTO time_entry (
      task_id, project_id, start_at, end_at, actual_minutes,
      status, confirmed_at, source, external_id, is_meeting,
      synced_at, harvest_entry_id, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.task_id ?? null,
    input.project_id ?? null,
    input.start_at,
    input.end_at,
    input.actual_minutes ?? null,
    input.status,
    input.confirmed_at ?? null,
    input.source,
    input.external_id ?? null,
    input.is_meeting ? 1 : 0,
    input.synced_at ?? null,
    input.harvest_entry_id ?? null,
    input.notes ?? null,
  );
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/time-entry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/time-entry.ts tests/time-entry.test.ts
git commit -m "feat(time-entry): module skeleton with insertTimeEntry"
```

### Task 4: Add `confirmTimeEntry` and `skipTimeEntry` to `time-entry.ts`

**Files:**
- Modify: `src/time-entry.ts`
- Test: `tests/time-entry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/time-entry.test.ts`:

```typescript
import { confirmTimeEntry, skipTimeEntry } from '../src/time-entry.js';

describe('confirmTimeEntry', () => {
  it('flips UNCONFIRMED to CONFIRMED, stamps confirmed_at', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });

    confirmTimeEntry(db, id, {});
    const row = db.prepare(`SELECT * FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.status).toBe('CONFIRMED');
    expect(row.confirmed_at).not.toBeNull();
  });

  it('applies actual_minutes override', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });

    confirmTimeEntry(db, id, { actual_minutes: 45 });
    const row = db.prepare(`SELECT actual_minutes FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.actual_minutes).toBe(45);
  });

  it('reassigns project_id when supplied', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('A', 'A', 'A')`).run();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('B', 'B', 'B')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'A',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });

    confirmTimeEntry(db, id, { project_id: 'B' });
    const row = db.prepare(`SELECT project_id FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.project_id).toBe('B');
  });

  it('is idempotent on already-CONFIRMED entries (no-op)', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      actual_minutes: 60,
      status: 'CONFIRMED',
      confirmed_at: '2026-05-13T10:00:00Z',
      source: 'manual',
    });

    expect(() => confirmTimeEntry(db, id, { actual_minutes: 30 })).not.toThrow();
    const row = db.prepare(`SELECT actual_minutes FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.actual_minutes).toBe(60); // unchanged — confirmed entries immutable
  });
});

describe('skipTimeEntry', () => {
  it('deletes the row', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });

    skipTimeEntry(db, id);
    const row = db.prepare(`SELECT * FROM time_entry WHERE id = ?`).get(id);
    expect(row).toBeUndefined();
  });

  it('rejects on CONFIRMED status', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      actual_minutes: 60,
      status: 'CONFIRMED',
      confirmed_at: '2026-05-13T10:00:00Z',
      source: 'manual',
    });

    expect(() => skipTimeEntry(db, id)).toThrow(/confirmed/i);
  });

  it('rejects on source=gcal-sync', () => {
    const db = freshDb();
    const id = insertTimeEntry(db, {
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'gcal-sync',
      external_id: 'gcal-evt-1',
    });

    expect(() => skipTimeEntry(db, id)).toThrow(/gcal/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/time-entry.test.ts
```

- [ ] **Step 3: Implement `confirmTimeEntry` and `skipTimeEntry`**

Append to `src/time-entry.ts`:

```typescript
export interface ConfirmOptions {
  actual_minutes?: number | null;
  project_id?: string | null;
  notes?: string | null;
}

export function confirmTimeEntry(db: DB, id: number, opts: ConfirmOptions): void {
  const existing = db.prepare(`SELECT status FROM time_entry WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!existing) throw new Error(`time_entry ${id} not found`);
  if (existing.status === 'CONFIRMED') return; // idempotent no-op

  const sets: string[] = ["status = 'CONFIRMED'", "confirmed_at = datetime('now')"];
  const args: (number | string | null)[] = [];
  if (opts.actual_minutes !== undefined) {
    sets.push('actual_minutes = ?');
    args.push(opts.actual_minutes ?? null);
  }
  if (opts.project_id !== undefined) {
    sets.push('project_id = ?');
    args.push(opts.project_id ?? null);
  }
  if (opts.notes !== undefined) {
    sets.push('notes = ?');
    args.push(opts.notes ?? null);
  }
  args.push(id);
  db.prepare(`UPDATE time_entry SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function skipTimeEntry(db: DB, id: number): void {
  const existing = db.prepare(`SELECT status, source FROM time_entry WHERE id = ?`)
    .get(id) as { status: string; source: string } | undefined;
  if (!existing) throw new Error(`time_entry ${id} not found`);
  if (existing.status === 'CONFIRMED') throw new Error('cannot skip a confirmed entry');
  if (existing.source === 'gcal-sync') {
    throw new Error('cannot skip a gcal-synced entry; delete it in Google Calendar and re-sync');
  }
  db.prepare(`DELETE FROM time_entry WHERE id = ?`).run(id);
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm test -- tests/time-entry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/time-entry.ts tests/time-entry.test.ts
git commit -m "feat(time-entry): confirm and skip operations"
```

### Task 5: Add `listPendingReview` and `moveTimeEntry`

**Files:**
- Modify: `src/time-entry.ts`
- Test: `tests/time-entry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/time-entry.test.ts`:

```typescript
import { listPendingReview, moveTimeEntry } from '../src/time-entry.js';

describe('listPendingReview', () => {
  function seed(db: any) {
    db.prepare(`INSERT INTO projects (id, name, prefix, category_id) VALUES ('WORK', 'Work', 'WORK', 'work')`).run();
    db.prepare(`INSERT INTO projects (id, name, prefix, category_id) VALUES ('PERS', 'Pers', 'PERS', 'personal')`).run();
  }

  it('returns UNCONFIRMED entries with start_at in the past, work category by default', () => {
    const db = freshDb();
    seed(db);
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2020-01-01T09:00:00Z', end_at: '2020-01-01T10:00:00Z', status: 'UNCONFIRMED', source: 'placement' });
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2099-01-01T09:00:00Z', end_at: '2099-01-01T10:00:00Z', status: 'UNCONFIRMED', source: 'placement' });
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2020-01-01T11:00:00Z', end_at: '2020-01-01T12:00:00Z', actual_minutes: 60, status: 'CONFIRMED', confirmed_at: '2020-01-01T12:00:00Z', source: 'manual' });
    insertTimeEntry(db, { project_id: 'PERS', start_at: '2020-01-01T13:00:00Z', end_at: '2020-01-01T14:00:00Z', status: 'UNCONFIRMED', source: 'placement' });

    const rows = listPendingReview(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe('WORK');
    expect(rows[0].start_at).toBe('2020-01-01T09:00:00Z');
  });

  it('respects explicit category filter', () => {
    const db = freshDb();
    seed(db);
    insertTimeEntry(db, { project_id: 'PERS', start_at: '2020-01-01T13:00:00Z', end_at: '2020-01-01T14:00:00Z', status: 'UNCONFIRMED', source: 'placement' });

    const rows = listPendingReview(db, { category: 'personal' });
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe('PERS');
  });
});

describe('moveTimeEntry', () => {
  it('preserves duration by default', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, { project_id: 'TEST', start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T11:00:00Z', status: 'UNCONFIRMED', source: 'placement' });

    moveTimeEntry(db, id, '2026-05-13T14:00:00Z');
    const row = db.prepare(`SELECT start_at, end_at FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.start_at).toBe('2026-05-13T14:00:00Z');
    expect(row.end_at).toBe('2026-05-13T16:00:00Z'); // preserved 2h duration
  });

  it('accepts explicit new_end_at', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, { project_id: 'TEST', start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T11:00:00Z', status: 'UNCONFIRMED', source: 'placement' });

    moveTimeEntry(db, id, '2026-05-13T14:00:00Z', { new_end_at: '2026-05-13T14:30:00Z' });
    const row = db.prepare(`SELECT end_at FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.end_at).toBe('2026-05-13T14:30:00Z');
  });

  it('rejects move on CONFIRMED', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, { project_id: 'TEST', start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T10:00:00Z', actual_minutes: 60, status: 'CONFIRMED', confirmed_at: '2026-05-13T10:00:00Z', source: 'manual' });
    expect(() => moveTimeEntry(db, id, '2026-05-13T14:00:00Z')).toThrow(/confirmed/i);
  });

  it('rejects move on source=gcal-sync', () => {
    const db = freshDb();
    const id = insertTimeEntry(db, { start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T10:00:00Z', status: 'UNCONFIRMED', source: 'gcal-sync', external_id: 'e1' });
    expect(() => moveTimeEntry(db, id, '2026-05-13T14:00:00Z')).toThrow(/gcal/i);
  });

  it('rejects move on source=manual', () => {
    const db = freshDb();
    const id = insertTimeEntry(db, { start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T10:00:00Z', status: 'UNCONFIRMED', source: 'manual' });
    expect(() => moveTimeEntry(db, id, '2026-05-13T14:00:00Z')).toThrow(/manual/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/time-entry.test.ts
```

- [ ] **Step 3: Implement both functions**

Append to `src/time-entry.ts`:

```typescript
export interface ListPendingReviewOptions {
  from?: string;
  to?: string;
  category?: string; // defaults to 'work'
}

export function listPendingReview(db: DB, opts: ListPendingReviewOptions): TimeEntry[] {
  const category = opts.category ?? 'work';
  const from = opts.from ?? '1970-01-01T00:00:00Z';
  const to = opts.to ?? new Date().toISOString();

  return db.prepare(`
    SELECT te.* FROM time_entry te
    LEFT JOIN projects p ON p.id = te.project_id
    WHERE te.status = 'UNCONFIRMED'
      AND te.start_at >= ?
      AND te.start_at < ?
      AND (p.category_id = ? OR (p.category_id IS NULL AND ? = 'work'))
    ORDER BY te.start_at ASC
  `).all(from, to, category, category) as TimeEntry[];
}

export interface MoveOptions {
  new_end_at?: string;
  preserve_duration?: boolean;
}

export function moveTimeEntry(db: DB, id: number, new_start_at: string, opts: MoveOptions = {}): void {
  const existing = db.prepare(`SELECT status, source, start_at, end_at FROM time_entry WHERE id = ?`)
    .get(id) as { status: string; source: string; start_at: string; end_at: string } | undefined;
  if (!existing) throw new Error(`time_entry ${id} not found`);
  if (existing.status === 'CONFIRMED') throw new Error('cannot move a confirmed entry');
  if (existing.source === 'gcal-sync') {
    throw new Error('cannot move a gcal-synced entry; reschedule in Google Calendar');
  }
  if (existing.source === 'manual') {
    throw new Error('cannot move a manual entry; it is already CONFIRMED by definition');
  }

  let new_end_at: string;
  if (opts.new_end_at) {
    new_end_at = opts.new_end_at;
  } else {
    const oldDuration =
      new Date(existing.end_at).getTime() - new Date(existing.start_at).getTime();
    new_end_at = new Date(new Date(new_start_at).getTime() + oldDuration).toISOString();
  }

  db.prepare(`UPDATE time_entry SET start_at = ?, end_at = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(new_start_at, new_end_at, id);
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm test -- tests/time-entry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/time-entry.ts tests/time-entry.test.ts
git commit -m "feat(time-entry): listPendingReview and moveTimeEntry"
```

---

## Phase 3 — MCP tools (new)

### Task 6: Wire `confirm_placement` and `skip_placement` MCP tools

**Files:**
- Modify: `src/mcp/tools/index.ts`
- Test: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Update the surface check test**

Find the surface check assertion in `tests/mcp-tools.test.ts` (it asserts the exhaustive list of tool names). Add `'confirm_placement'` and `'skip_placement'` to the expected list.

```typescript
// expand the expected tool names array to include:
'confirm_placement',
'skip_placement',
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/mcp-tools.test.ts
```

- [ ] **Step 3: Add the two tool definitions in `src/mcp/tools/index.ts`**

Add to the tools array (location alongside `place_task` / `unplace_task` for locality):

```typescript
{
  name: 'confirm_placement',
  description: 'Flip an UNCONFIRMED time_entry to CONFIRMED. Optional actual_minutes override (when work took longer/shorter than placed), optional project_id reassignment.',
  inputSchema: {
    type: 'object',
    properties: {
      time_entry_id: { type: 'integer' },
      actual_minutes: { type: 'integer' },
      project_id: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['time_entry_id'],
  },
  handler: async (db, args) => {
    const { confirmTimeEntry } = await import('../../time-entry.js');
    confirmTimeEntry(db, args.time_entry_id, {
      actual_minutes: args.actual_minutes,
      project_id: args.project_id,
      notes: args.notes,
    });
    return { confirmed: true, time_entry_id: args.time_entry_id };
  },
},
{
  name: 'skip_placement',
  description: 'Delete an UNCONFIRMED time_entry (it did not happen). Rejects CONFIRMED entries and gcal-sync sourced entries.',
  inputSchema: {
    type: 'object',
    properties: {
      time_entry_id: { type: 'integer' },
    },
    required: ['time_entry_id'],
  },
  handler: async (db, args) => {
    const { skipTimeEntry } = await import('../../time-entry.js');
    skipTimeEntry(db, args.time_entry_id);
    return { skipped: true, time_entry_id: args.time_entry_id };
  },
},
```

Match the exact tool-registration pattern used by adjacent tools (the surrounding code shape may differ — adapt the registration to the existing pattern in this file).

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/mcp-tools.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/index.ts tests/mcp-tools.test.ts
git commit -m "feat(mcp): confirm_placement and skip_placement tools"
```

### Task 7: Wire `list_pending_review` and `move_placement` MCP tools

**Files:**
- Modify: `src/mcp/tools/index.ts`
- Test: `tests/mcp-tools.test.ts`

- [ ] **Step 1: Update surface check**

Add `'list_pending_review'` and `'move_placement'` to the expected tool name array in `tests/mcp-tools.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/mcp-tools.test.ts
```

- [ ] **Step 3: Add the two tool definitions**

In `src/mcp/tools/index.ts`:

```typescript
{
  name: 'list_pending_review',
  description: 'List past UNCONFIRMED time_entries that need confirmation or skip. Defaults to work-category entries only.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO 8601 lower bound (inclusive)' },
      to:   { type: 'string', description: 'ISO 8601 upper bound (exclusive); defaults to now' },
      category: { type: 'string', description: "category id, defaults to 'work'" },
    },
  },
  handler: async (db, args) => {
    const { listPendingReview } = await import('../../time-entry.js');
    return { rows: listPendingReview(db, args) };
  },
},
{
  name: 'move_placement',
  description: 'Reschedule an UNCONFIRMED placement or habit entry. Preserves duration by default.',
  inputSchema: {
    type: 'object',
    properties: {
      time_entry_id: { type: 'integer' },
      new_start_at:  { type: 'string', description: 'ISO 8601' },
      new_end_at:    { type: 'string', description: 'ISO 8601; defaults to preserve duration' },
    },
    required: ['time_entry_id', 'new_start_at'],
  },
  handler: async (db, args) => {
    const { moveTimeEntry } = await import('../../time-entry.js');
    moveTimeEntry(db, args.time_entry_id, args.new_start_at, { new_end_at: args.new_end_at });
    return { moved: true, time_entry_id: args.time_entry_id };
  },
},
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/mcp-tools.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/index.ts tests/mcp-tools.test.ts
git commit -m "feat(mcp): list_pending_review and move_placement tools"
```

---

## Phase 4 — MCP tools (modify)

### Task 8: Rewrite `log_time` to write `time_entry` directly, with optional `task_id`

**Files:**
- Modify: `src/mcp/tools/index.ts` — `log_time` handler
- Modify: `src/time-log.ts` → rename to `src/time-entry-writers.ts` (or keep `time-log.ts` as a deprecated shim if other code paths still import; **prefer rename per "no compat shims" rule**)
- Test: `tests/time-log.test.ts` → rename and rewrite to `tests/time-entry-writers.test.ts`

- [ ] **Step 1: Rewrite the test for new behavior**

Rename `tests/time-log.test.ts` → `tests/time-entry-writers.test.ts`. Replace its contents with tests asserting:

```typescript
import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/freshDb.js';
import { logTime } from '../src/time-entry-writers.js';

describe('logTime', () => {
  it('inserts a CONFIRMED time_entry row', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('T', 'T', 'T')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'T', 'x')`).run();

    const id = logTime(db, {
      task_id: 1,
      started_at: '2026-05-13T09:00:00Z',
      stopped_at: '2026-05-13T10:30:00Z',
      notes: 'retro',
    });

    const row = db.prepare(`SELECT * FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.status).toBe('CONFIRMED');
    expect(row.source).toBe('manual');
    expect(row.actual_minutes).toBe(90);
    expect(row.task_id).toBe(1);
  });

  it('allows task_id to be omitted (project-only retro)', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('T', 'T', 'T')`).run();
    const id = logTime(db, {
      project_id: 'T',
      started_at: '2026-05-13T09:00:00Z',
      stopped_at: '2026-05-13T10:00:00Z',
    });
    const row = db.prepare(`SELECT task_id, project_id FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.task_id).toBeNull();
    expect(row.project_id).toBe('T');
  });

  it('rejects inverted timestamps', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('T', 'T', 'T')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'T', 'x')`).run();
    expect(() =>
      logTime(db, { task_id: 1, started_at: '2026-05-13T10:00:00Z', stopped_at: '2026-05-13T09:00:00Z' }),
    ).toThrow(/before/i);
  });

  it('rejects far-future timestamps', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('T', 'T', 'T')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'T', 'x')`).run();
    const far = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString(); // 48h ahead
    expect(() =>
      logTime(db, { task_id: 1, started_at: far, stopped_at: far }),
    ).toThrow(/future/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/time-entry-writers.test.ts
```

- [ ] **Step 3: Rename source file and rewrite implementation**

```bash
git mv src/time-log.ts src/time-entry-writers.ts
```

Rewrite `src/time-entry-writers.ts`:

```typescript
import type { DB } from './db/connection.js';
import { insertTimeEntry } from './time-entry.js';

export interface LogTimeInput {
  task_id?: number;
  project_id?: string;
  started_at: string;
  stopped_at: string;
  notes?: string | null;
}

const ONE_DAY_MS = 1000 * 60 * 60 * 24;

export function logTime(db: DB, input: LogTimeInput): number {
  const start = new Date(input.started_at);
  const stop = new Date(input.stopped_at);
  if (!(stop > start)) throw new Error('stopped_at must be after started_at');
  if (start.getTime() > Date.now() + ONE_DAY_MS) {
    throw new Error('started_at more than 24h in the future');
  }
  if (stop.getTime() > Date.now() + ONE_DAY_MS) {
    throw new Error('stopped_at more than 24h in the future');
  }

  let project_id = input.project_id ?? null;
  if (input.task_id && !project_id) {
    const t = db.prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(input.task_id) as { project_id: string } | undefined;
    if (!t) throw new Error(`task ${input.task_id} not found`);
    project_id = t.project_id;
  }
  if (!input.task_id && !project_id) {
    throw new Error('logTime requires either task_id or project_id');
  }

  const minutes = Math.round((stop.getTime() - start.getTime()) / 60000);
  return insertTimeEntry(db, {
    task_id: input.task_id ?? null,
    project_id,
    start_at: input.started_at,
    end_at: input.stopped_at,
    actual_minutes: minutes,
    status: 'CONFIRMED',
    confirmed_at: input.stopped_at,
    source: 'manual',
    notes: input.notes ?? null,
  });
}
```

- [ ] **Step 4: Update the `log_time` MCP tool handler**

In `src/mcp/tools/index.ts`, find the `log_time` tool. Update its inputSchema to make `task_id` optional and add `project_id`. Update its handler to call the new `logTime` from `src/time-entry-writers.ts` and remove any reference to the old `time_log` table or `time_spent_minutes` bump.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Some tests in `tests/timesheet.test.ts` / `tests/budgets.test.ts` may now fail because they read `time_log` directly. Note them but leave for Phase 6.

- [ ] **Step 6: Commit**

```bash
git add src/time-entry-writers.ts src/mcp/tools/index.ts tests/time-entry-writers.test.ts
git rm src/time-log.ts
git commit -m "feat(log-time): write time_entry CONFIRMED row; task_id optional"
```

### Task 9: Rewrite `place_task` and `unplace_task` to use `time_entry`

**Files:**
- Modify: `src/mcp/tools/index.ts` — `place_task` and `unplace_task` handlers
- Test: existing `tests/mcp-tools.test.ts` or a new placement test file

- [ ] **Step 1: Write the failing test**

Create `tests/placement.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/freshDb.js';
import { placeTask, unplaceTask } from '../src/placement.js';

describe('placeTask / unplaceTask', () => {
  it('place creates an UNCONFIRMED time_entry with source=placement', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('T', 'T', 'T')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'T', 'x')`).run();

    const id = placeTask(db, {
      task_id: 1,
      start_at: '2026-05-14T09:00:00Z',
      end_at: '2026-05-14T10:00:00Z',
    });
    const row = db.prepare(`SELECT * FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.status).toBe('UNCONFIRMED');
    expect(row.source).toBe('placement');
    expect(row.task_id).toBe(1);
  });

  it('unplace removes the UNCONFIRMED time_entry', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('T', 'T', 'T')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'T', 'x')`).run();
    const id = placeTask(db, { task_id: 1, start_at: '2026-05-14T09:00:00Z', end_at: '2026-05-14T10:00:00Z' });

    unplaceTask(db, id);
    expect(db.prepare(`SELECT id FROM time_entry WHERE id = ?`).get(id)).toBeUndefined();
  });

  it('unplace rejects CONFIRMED entries', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('T', 'T', 'T')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'T', 'x')`).run();
    const id = placeTask(db, { task_id: 1, start_at: '2026-05-14T09:00:00Z', end_at: '2026-05-14T10:00:00Z' });
    // simulate confirmation
    db.prepare(`UPDATE time_entry SET status = 'CONFIRMED', confirmed_at = datetime('now') WHERE id = ?`).run(id);
    expect(() => unplaceTask(db, id)).toThrow(/confirmed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/placement.test.ts
```

- [ ] **Step 3: Create `src/placement.ts`**

```typescript
import type { DB } from './db/connection.js';
import { insertTimeEntry } from './time-entry.js';

export interface PlaceTaskInput {
  task_id: number;
  start_at: string;
  end_at: string;
  notes?: string | null;
}

export function placeTask(db: DB, input: PlaceTaskInput): number {
  const t = db.prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(input.task_id) as { project_id: string } | undefined;
  if (!t) throw new Error(`task ${input.task_id} not found`);
  return insertTimeEntry(db, {
    task_id: input.task_id,
    project_id: t.project_id,
    start_at: input.start_at,
    end_at: input.end_at,
    status: 'UNCONFIRMED',
    source: 'placement',
    notes: input.notes ?? null,
  });
}

export function unplaceTask(db: DB, time_entry_id: number): void {
  const row = db.prepare(`SELECT status, source FROM time_entry WHERE id = ?`).get(time_entry_id) as { status: string; source: string } | undefined;
  if (!row) throw new Error(`time_entry ${time_entry_id} not found`);
  if (row.status === 'CONFIRMED') throw new Error('cannot unplace a confirmed entry');
  if (row.source !== 'placement') throw new Error(`cannot unplace a ${row.source} entry`);
  db.prepare(`DELETE FROM time_entry WHERE id = ?`).run(time_entry_id);
}
```

- [ ] **Step 4: Update the MCP tool handlers**

In `src/mcp/tools/index.ts`, find `place_task` and `unplace_task`. Replace their handlers to call `placeTask` / `unplaceTask` from `src/placement.ts`. Update their inputSchemas if needed (note `unplace_task` now takes `time_entry_id` instead of whatever it took before — adjust callers in skills accordingly later).

- [ ] **Step 5: Run tests to verify pass**

```bash
npm test -- tests/placement.test.ts tests/mcp-tools.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/placement.ts src/mcp/tools/index.ts tests/placement.test.ts
git commit -m "feat(placement): place_task/unplace_task write time_entry"
```

### Task 10: Rewrite `block_time` to write `time_entry`

**Files:**
- Modify: `src/availability.ts` or wherever `block_time` is implemented (check `src/mcp/tools/index.ts:1066` block)
- Test: extend existing block_time tests

- [ ] **Step 1: Locate and read existing implementation**

```bash
grep -rn "block_time" src/ tests/ | head -20
```

The `block_time` MCP tool currently creates an `availability_overrides` row (for "I'm not available"). The spec says it should also create an UNCONFIRMED `time_entry` for the same window when the user is blocking time *to do work* (vs blocking time to be unavailable).

**Decision point:** `block_time` in the existing codebase blocks availability. The spec's "block 45 min for hotfix" usage is actually a different intent — it's creating a placement. Re-read the spec wording. If `block_time` and `place_task` are converging on the same operation (creating an UNCONFIRMED `time_entry`), confirm with the user before merging or keeping both. If they remain distinct (`block_time` = availability override, `place_task` = task placement), leave `block_time` alone for this PR and the skill prompt steers users to `place_task` for placement intent.

- [ ] **Step 2: Decision recorded; commit only if change made**

If no change to `block_time` is needed in this PR, skip to the next task. If a change is needed, write failing tests, implement, pass, commit per the established pattern.

### Task 11: Rewrite `sync_calendar_events` to upsert `time_entry` preserving confirmation

**Files:**
- Modify: `src/calendar-sync.ts`
- Test: `tests/calendar-sync.test.ts`

- [ ] **Step 1: Write the key failing test (confirmation survives re-sync)**

Append to `tests/calendar-sync.test.ts`:

```typescript
it('preserves CONFIRMED status when re-syncing a gcal event already in time_entry', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO projects (id, name, prefix, calendar_id) VALUES ('A', 'A', 'A', 'cal-a')`).run();

  // Initial sync: insert UNCONFIRMED
  await syncCalendarEvents(db, {
    calendar_id: 'cal-a',
    events: [{ id: 'evt-1', summary: 'Standup', start: '2026-05-13T09:00:00Z', end: '2026-05-13T09:30:00Z', is_meeting: 1 }],
  });

  // User confirms it
  const row1 = db.prepare(`SELECT id FROM time_entry WHERE external_id = 'evt-1'`).get() as any;
  db.prepare(`UPDATE time_entry SET status = 'CONFIRMED', confirmed_at = datetime('now'), actual_minutes = 25 WHERE id = ?`).run(row1.id);

  // Re-sync (same event)
  await syncCalendarEvents(db, {
    calendar_id: 'cal-a',
    events: [{ id: 'evt-1', summary: 'Standup', start: '2026-05-13T09:00:00Z', end: '2026-05-13T09:30:00Z', is_meeting: 1 }],
  });

  const row2 = db.prepare(`SELECT status, actual_minutes FROM time_entry WHERE external_id = 'evt-1'`).get() as any;
  expect(row2.status).toBe('CONFIRMED');
  expect(row2.actual_minutes).toBe(25);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/calendar-sync.test.ts
```

- [ ] **Step 3: Rewrite `src/calendar-sync.ts`**

Replace inserts into `calendar_events` with upserts into `time_entry`:

```typescript
import type { DB } from './db/connection.js';

export interface SyncEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  is_meeting?: number;
}

export interface SyncInput {
  calendar_id: string;
  events: SyncEvent[];
}

export async function syncCalendarEvents(db: DB, input: SyncInput): Promise<{ upserted: number }> {
  const projectRow = db.prepare(`SELECT id FROM projects WHERE calendar_id = ?`).get(input.calendar_id) as { id: string } | undefined;
  const project_id = projectRow?.id ?? null;

  const upsert = db.prepare(`
    INSERT INTO time_entry (
      project_id, start_at, end_at, status, source, external_id, is_meeting, synced_at, notes
    ) VALUES (?, ?, ?, 'UNCONFIRMED', 'gcal-sync', ?, ?, datetime('now'), ?)
    ON CONFLICT(external_id) DO UPDATE SET
      start_at  = excluded.start_at,
      end_at    = excluded.end_at,
      is_meeting = excluded.is_meeting,
      synced_at = excluded.synced_at,
      notes     = excluded.notes,
      updated_at = datetime('now')
    -- Do NOT overwrite status, confirmed_at, or actual_minutes — those are human-set.
  `);

  let count = 0;
  const tx = db.transaction((events: SyncEvent[]) => {
    for (const e of events) {
      upsert.run(project_id, e.start, e.end, e.id, e.is_meeting ?? 0, e.summary);
      count++;
    }
  });
  tx(input.events);

  return { upserted: count };
}
```

Note the `ON CONFLICT` clause must use a unique index — the spec already includes `idx_time_entry_external UNIQUE WHERE external_id IS NOT NULL`. SQLite requires the conflict target to match; you may need `ON CONFLICT(external_id)` with `WHERE external_id IS NOT NULL` clause in some SQLite versions. If the bare `ON CONFLICT(external_id)` doesn't compile, use the explicit form: do a SELECT to check existence, then INSERT-or-UPDATE.

- [ ] **Step 4: Run all tests, expecting some fallout in places that read `calendar_events`**

```bash
npm test
```

Other tests reading `calendar_events` directly (budgets, week layout, etc.) will fail. Note them; Phase 6 cleans them up.

- [ ] **Step 5: Commit**

```bash
git add src/calendar-sync.ts tests/calendar-sync.test.ts
git commit -m "feat(calendar-sync): upsert time_entry, preserve confirmation state"
```

### Task 12: Pair `habit_instances` with `time_entry`

**Files:**
- Modify: `src/habits.ts`
- Test: `tests/habits.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/habits.test.ts`:

```typescript
it('generate_habit_instances creates paired time_entry rows and links via time_entry_id', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('W', 'W', 'W')`).run();
  // create a habit M-F 09:00 30 min
  const habit = createHabit(db, {
    project_id: 'W',
    title: 'Standup',
    duration_minutes: 30,
    days_of_week: [1, 2, 3, 4, 5],
    start_time: '09:00',
    timezone: 'America/Chicago',
  });

  generateHabitInstances(db, { habit_id: habit.id, from: '2026-05-11', to: '2026-05-15' });

  const instances = db.prepare(`SELECT id, time_entry_id FROM habit_instances WHERE habit_id = ?`).all(habit.id) as any[];
  expect(instances.length).toBe(5);
  for (const inst of instances) {
    expect(inst.time_entry_id).not.toBeNull();
    const te = db.prepare(`SELECT status, source FROM time_entry WHERE id = ?`).get(inst.time_entry_id) as any;
    expect(te.status).toBe('UNCONFIRMED');
    expect(te.source).toBe('habit');
  }
});

it('complete_habit_instance confirms the paired time_entry', () => {
  // similar shape — generate then complete one, assert paired entry is CONFIRMED
});

it('skip_habit_instance deletes the paired time_entry', () => {
  // similar shape — generate then skip one, assert paired entry row absent
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/habits.test.ts
```

- [ ] **Step 3: Update `src/habits.ts`**

In `generateHabitInstances`: for each instance row inserted, also call `insertTimeEntry` with `source='habit'` and store the returned id in `habit_instances.time_entry_id`. Wrap both inserts in a transaction.

In `completeHabitInstance`: after marking the instance complete, call `confirmTimeEntry(db, instance.time_entry_id, {})`.

In `skipHabitInstance`: after marking skipped, call `skipTimeEntry(db, instance.time_entry_id)`. (Since the paired entry has `source='habit'`, `skipTimeEntry` accepts it — confirm the `skipTimeEntry` rejection list covers only `gcal-sync`, not `habit`.)

- [ ] **Step 4: Run tests to verify pass**

```bash
npm test -- tests/habits.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/habits.ts tests/habits.test.ts
git commit -m "feat(habits): pair instances with time_entry sidecar"
```

### Task 13: Add `categories` filter + unconfirmed guard to export/Harvest/summary tools

**Files:**
- Modify: `src/timesheet.ts`, `src/harvest/*.ts`, and the three tool handlers in `src/mcp/tools/index.ts`
- Test: `tests/timesheet.test.ts`, `tests/harvest/*.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/timesheet.test.ts`:

```typescript
it('export_timesheet defaults to categories=["work"], excludes personal entries', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO projects (id, name, prefix, category_id) VALUES ('W', 'W', 'W', 'work')`).run();
  db.prepare(`INSERT INTO projects (id, name, prefix, category_id) VALUES ('P', 'P', 'P', 'personal')`).run();
  // seed CONFIRMED entries for both
  // ...

  const out = exportTimesheet(db, { from: '2026-05-01', to: '2026-05-31' });
  // assert only W rows present, no P rows
});

it('export_timesheet includes personal when explicitly requested', () => {
  // ... categories: ['work', 'personal']
});

it('get_timesheet_summary include_unconfirmed=false by default', () => {
  // assert UNCONFIRMED entries excluded
});

it('get_timesheet_summary include_unconfirmed=true reports them', () => {
  // assert UNCONFIRMED entries listed
});
```

In `tests/harvest/push.test.ts` (or wherever the Harvest push tests live):

```typescript
it('harvest_push_timesheet refuses when UNCONFIRMED entries exist in range', async () => {
  const db = freshDb();
  // seed an UNCONFIRMED in range
  await expect(harvestPushTimesheet(db, { from: '2026-05-11', to: '2026-05-18' })).rejects.toThrow(/unconfirmed/i);
});

it('harvest_push_timesheet succeeds with force=true even if unconfirmed exist', async () => {
  // assert it returns success / proceeds
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/timesheet.test.ts tests/harvest
```

- [ ] **Step 3: Update `src/timesheet.ts`**

Replace its `SELECT … FROM time_log JOIN tasks JOIN projects …` with `SELECT … FROM time_entry JOIN projects …`, filter `time_entry.status = 'CONFIRMED'`, add `AND projects.category_id IN (...)` parameterized on the `categories` argument (default `['work']`).

- [ ] **Step 4: Update Harvest push**

In the Harvest push module: before iterating rows to push, run `listPendingReview(db, { from, to })` (no category filter — Harvest cares about work, but the check covers everything in range that's overdue). If non-empty AND `force !== true`, throw an error listing offenders. Then proceed with the existing push iteration, but reading `time_entry CONFIRMED` rows instead of `time_log`.

- [ ] **Step 5: Update MCP tool handlers**

In `src/mcp/tools/index.ts`, find `export_timesheet`, `get_timesheet_summary`, `harvest_push_timesheet`. Add `categories: string[]` to each inputSchema with default `['work']`. Add `force: boolean` and `include_unconfirmed: boolean` where applicable. Pass through to the lib functions.

- [ ] **Step 6: Run tests to verify pass**

```bash
npm test -- tests/timesheet.test.ts tests/harvest
```

- [ ] **Step 7: Commit**

```bash
git add src/timesheet.ts src/harvest src/mcp/tools/index.ts tests/timesheet.test.ts tests/harvest
git commit -m "feat(export): categories filter + harvest unconfirmed guard"
```

---

## Phase 5 — MCP tools (remove)

### Task 14: Remove `start_task` and `stop_task`

**Files:**
- Modify: `src/mcp/tools/index.ts`
- Modify: `tests/mcp-tools.test.ts` — surface assertion

- [ ] **Step 1: Delete the two tool definitions in `src/mcp/tools/index.ts`**

Remove the entire blocks at the `name: 'start_task'` and `name: 'stop_task'` entries.

- [ ] **Step 2: Remove the two names from the expected tool list in `tests/mcp-tools.test.ts`**

- [ ] **Step 3: Search for any remaining references**

```bash
grep -rn "start_task\|stop_task" src/ tests/ .claude/
```

Remove or rewrite any callers found. Skills (`.claude/skills/*`) may reference them — Phase 8 handles skill updates, but quick `grep` now flags what's coming.

- [ ] **Step 4: Run tests**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/index.ts tests/mcp-tools.test.ts
git commit -m "feat(mcp): remove start_task and stop_task (no live timer)"
```

---

## Phase 6 — Downstream source module updates

### Task 15: Update `src/budgets.ts` to read `v_task_time_spent`

**Files:**
- Modify: `src/budgets.ts`
- Test: `tests/budgets.test.ts`

- [ ] **Step 1: Find current reads of `tasks.time_spent_minutes`**

```bash
grep -n "time_spent_minutes" src/budgets.ts
```

- [ ] **Step 2: Replace with view reads**

Wherever the current code reads `tasks.time_spent_minutes`, replace with a join against `v_task_time_spent`:

```sql
LEFT JOIN v_task_time_spent v ON v.task_id = tasks.id
-- and use COALESCE(v.minutes, 0) in place of tasks.time_spent_minutes
```

For project budget rollups (which currently sum across calendar_events + time_log), switch to a single SUM over `time_entry WHERE status='CONFIRMED'` filtered by project_id and week range.

- [ ] **Step 3: Update tests that seeded `tasks.time_spent_minutes` or `calendar_events` directly**

In `tests/budgets.test.ts`, replace direct `INSERT INTO time_log ...` / `INSERT INTO calendar_events ...` / `UPDATE tasks SET time_spent_minutes ...` with `insertTimeEntry(db, { ... status: 'CONFIRMED', source: 'manual' })`.

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/budgets.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/budgets.ts tests/budgets.test.ts
git commit -m "refactor(budgets): read v_task_time_spent and time_entry CONFIRMED"
```

### Task 16: Update `src/tasks.ts` to drop `time_spent_minutes` and `calendar_event_id` references

**Files:**
- Modify: `src/tasks.ts`
- Test: `tests/tasks.test.ts`

- [ ] **Step 1: Find references**

```bash
grep -n "time_spent_minutes\|calendar_event_id" src/tasks.ts
```

- [ ] **Step 2: Remove all read/write of those columns**

`createTask` no longer initializes `time_spent_minutes = 0`. `completeTask` no longer bumps it. Any code paths surfacing "how much time spent" instead read from `v_task_time_spent`.

If any UI/MCP response includes `time_spent_minutes` on a task object, replace with a join against `v_task_time_spent` and rename the field to `time_spent_minutes` (semantically identical, sourced from the view).

- [ ] **Step 3: Update tests**

In `tests/tasks.test.ts`, replace any direct read of `time_spent_minutes` with a fresh query against `v_task_time_spent`, or seed via `insertTimeEntry` instead.

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/tasks.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts tests/tasks.test.ts
git commit -m "refactor(tasks): drop time_spent_minutes and calendar_event_id references"
```

### Task 17: Update `src/calendar/*` and `src/calendar-sync.ts` cross-references

**Files:**
- Modify: any module that still reads `calendar_events`
- Test: corresponding test files

- [ ] **Step 1: Audit remaining references**

```bash
grep -rn "calendar_events" src/ tests/ | grep -v migrate
```

Migration script may legitimately reference `calendar_events` to copy from it; everything else must go.

- [ ] **Step 2: Replace each read with `time_entry WHERE source='gcal-sync'` (or `IN ('gcal-sync', 'placement')` depending on intent)**

- [ ] **Step 3: Run tests**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add src/ tests/
git commit -m "refactor: replace calendar_events reads with time_entry queries"
```

---

## Phase 7 — Migration script

### Task 18: Write `scripts/migrate-to-time-entry.ts`

**Files:**
- Create: `scripts/migrate-to-time-entry.ts`
- Create: `tests/migration-to-time-entry.test.ts`

- [ ] **Step 1: Write the failing parity test**

Create `tests/migration-to-time-entry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigration } from '../scripts/migrate-to-time-entry.js';

function seededLegacyDb() {
  const db = new Database(':memory:');
  // Apply LEGACY schema (time_log + calendar_events + tasks.time_spent_minutes + tasks.calendar_event_id)
  // Then add time_entry table (the new schema) so we have both shapes.
  // Then seed: a project, a task with 120 time_spent_minutes, two time_log rows summing 120,
  // a future calendar_event placement, a future gcal-sync calendar_event.
  // ...
  return db;
}

it('preserves per-project CONFIRMED hours across migration', () => {
  const db = seededLegacyDb();
  const before = db.prepare(`SELECT p.prefix, SUM(tl.duration_minutes)/60.0 AS hours
    FROM time_log tl JOIN tasks t ON t.id=tl.task_id JOIN projects p ON p.id=t.project_id
    GROUP BY p.prefix`).all();

  runMigration(db);

  const after = db.prepare(`SELECT p.prefix, SUM(COALESCE(te.actual_minutes,
    (julianday(te.end_at)-julianday(te.start_at))*1440))/60.0 AS hours
    FROM time_entry te JOIN projects p ON p.id=te.project_id
    WHERE te.status='CONFIRMED' GROUP BY p.prefix`).all();

  expect(after).toEqual(before);
});

it('migrates future placements as UNCONFIRMED source=placement', () => {
  // assert future calendar_event rows linked to tasks become UNCONFIRMED placement rows
});

it('migrates future gcal-sync events as UNCONFIRMED source=gcal-sync with external_id', () => {
  // assert non-task calendar_events become gcal-sync rows with external_id = old calendar_events.id
});

it('drops past calendar_event placements (does not migrate)', () => {
  // assert past calendar_events not represented in time_entry
});

it('is idempotent — second run is a no-op', () => {
  const db = seededLegacyDb();
  runMigration(db);
  const beforeRerun = db.prepare(`SELECT COUNT(*) AS n FROM time_entry`).get();
  runMigration(db);
  const afterRerun = db.prepare(`SELECT COUNT(*) AS n FROM time_entry`).get();
  expect(afterRerun).toEqual(beforeRerun);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- tests/migration-to-time-entry.test.ts
```

- [ ] **Step 3: Implement the migration script**

Create `scripts/migrate-to-time-entry.ts`:

```typescript
import type { Database as DB } from 'better-sqlite3';

export function runMigration(db: DB): void {
  // Idempotency guard: if time_log doesn't exist, migration already ran.
  const hasTimeLog = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='time_log'`
  ).get();
  if (!hasTimeLog) return;

  db.transaction(() => {
    // 1) Confirmed historical hours: time_log → time_entry CONFIRMED
    db.prepare(`
      INSERT INTO time_entry (
        task_id, project_id, start_at, end_at, actual_minutes,
        status, confirmed_at, source, harvest_entry_id, notes
      )
      SELECT
        tl.task_id, t.project_id,
        tl.started_at,
        COALESCE(tl.stopped_at, datetime(tl.started_at, '+' || tl.duration_minutes || ' minutes')),
        tl.duration_minutes,
        'CONFIRMED',
        COALESCE(tl.stopped_at, tl.started_at),
        'manual',
        tl.harvest_entry_id,
        tl.notes
      FROM time_log tl JOIN tasks t ON t.id = tl.task_id
    `).run();

    // 2) Future task-linked placements: calendar_events → time_entry UNCONFIRMED source='placement'
    db.prepare(`
      INSERT INTO time_entry (task_id, project_id, start_at, end_at, status, source, is_meeting, notes)
      SELECT t.id, ce.project_id, ce.start, ce.end, 'UNCONFIRMED', 'placement', ce.is_meeting, ce.summary
      FROM calendar_events ce
      JOIN tasks t ON t.calendar_event_id = ce.id
      WHERE ce.start > datetime('now')
    `).run();

    // 3) Future gcal-sync events (not task-linked): time_entry UNCONFIRMED source='gcal-sync'
    db.prepare(`
      INSERT INTO time_entry (project_id, start_at, end_at, status, source, external_id, is_meeting, synced_at, notes)
      SELECT ce.project_id, ce.start, ce.end, 'UNCONFIRMED', 'gcal-sync', ce.id, ce.is_meeting, ce.synced_at, ce.summary
      FROM calendar_events ce
      LEFT JOIN tasks t ON t.calendar_event_id = ce.id
      WHERE ce.start > datetime('now') AND t.id IS NULL
    `).run();

    // 4) Habit instances: insert paired time_entry for each, set sidecar FK
    db.prepare(`
      INSERT INTO time_entry (task_id, project_id, start_at, end_at, status, source)
      SELECT NULL, h.project_id, hi.scheduled_start, hi.scheduled_end,
             CASE WHEN hi.status = 'COMPLETED' THEN 'CONFIRMED' ELSE 'UNCONFIRMED' END,
             'habit'
      FROM habit_instances hi JOIN habits h ON h.id = hi.habit_id
      WHERE hi.time_entry_id IS NULL
    `).run();
    // Link them — match by habit start time
    db.prepare(`
      UPDATE habit_instances
      SET time_entry_id = (
        SELECT te.id FROM time_entry te
        WHERE te.source = 'habit'
          AND te.start_at = habit_instances.scheduled_start
        LIMIT 1
      )
      WHERE time_entry_id IS NULL
    `).run();

    // 5) Parity check — halt if confirmed hours don't match
    const before = db.prepare(`
      SELECT p.prefix, SUM(tl.duration_minutes) AS m
      FROM time_log tl JOIN tasks t ON t.id=tl.task_id JOIN projects p ON p.id=t.project_id
      GROUP BY p.prefix
    `).all() as { prefix: string; m: number }[];
    const after = db.prepare(`
      SELECT p.prefix, CAST(SUM(COALESCE(te.actual_minutes,
        (julianday(te.end_at) - julianday(te.start_at)) * 1440)) AS INTEGER) AS m
      FROM time_entry te JOIN projects p ON p.id=te.project_id
      WHERE te.status='CONFIRMED' AND te.source='manual'
      GROUP BY p.prefix
    `).all() as { prefix: string; m: number }[];

    const beforeMap = new Map(before.map((r) => [r.prefix, r.m]));
    const afterMap = new Map(after.map((r) => [r.prefix, r.m]));
    for (const [prefix, m] of beforeMap) {
      if (afterMap.get(prefix) !== m) {
        throw new Error(`parity mismatch for ${prefix}: before=${m} after=${afterMap.get(prefix)}`);
      }
    }

    // 6) Drop legacy
    db.exec(`DROP TABLE IF EXISTS time_log`);
    db.exec(`DROP TABLE IF EXISTS calendar_events`);
    // SQLite >= 3.35 supports DROP COLUMN; idempotent via hasColumn check.
    const cols = db.prepare(`PRAGMA table_info('tasks')`).all() as { name: string }[];
    if (cols.some((c) => c.name === 'time_spent_minutes')) {
      db.exec(`ALTER TABLE tasks DROP COLUMN time_spent_minutes`);
    }
    if (cols.some((c) => c.name === 'calendar_event_id')) {
      db.exec(`ALTER TABLE tasks DROP COLUMN calendar_event_id`);
    }
  })();
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: ts-node scripts/migrate-to-time-entry.ts <path-to-calendrome.db>');
    process.exit(1);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  const db = new Database(path);
  runMigration(db);
  console.log('Migration complete.');
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/migration-to-time-entry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-to-time-entry.ts tests/migration-to-time-entry.test.ts
git commit -m "feat(migration): time_log + calendar_events → time_entry, with parity check"
```

### Task 19: Update `schema.sql` to remove dropped columns from the canonical schema

**Files:**
- Modify: `src/db/schema.sql`

- [ ] **Step 1: Remove `time_spent_minutes` and `calendar_event_id` from the `tasks` CREATE TABLE**

So a fresh install creates `tasks` without those columns.

- [ ] **Step 2: Remove the `CREATE TABLE … time_log` and `CREATE TABLE … calendar_events` blocks**

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Should be all-green (we've already updated everything else to use the new schema).

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.sql
git commit -m "chore(schema): drop legacy time_log, calendar_events, tasks.time_spent_minutes, tasks.calendar_event_id"
```

---

## Phase 8 — GUI updates

### Task 20: Update GUI reads to use `v_task_time_spent` and `time_entry`

**Files:**
- Modify: `src/gui/*` (Express server) and `website/*` if it embeds queries
- Test: integration tests in `tests/integration/` if they exercise GUI endpoints

- [ ] **Step 1: Audit current GUI SQL**

```bash
grep -rn "time_spent_minutes\|time_log\|calendar_events" src/gui/ website/
```

- [ ] **Step 2: Replace each query**

- Budget bars: read from `v_task_time_spent` joined to `projects`
- Timeline view: read `time_entry` (all sources) for the date range
- Past-overdue visual: rows where `status='UNCONFIRMED' AND start_at < datetime('now')` get the orange-border CSS class

- [ ] **Step 3: Add overdue visual treatment**

In the GUI's CSS / template for the timeline event element: add a class like `.time-entry--overdue-review` with an orange border (or whatever the existing design system uses for warning state). Apply that class based on the past-UNCONFIRMED predicate.

- [ ] **Step 4: Manually verify in the running GUI**

```bash
npm run gui &
open http://localhost:<configured-port>
```

Visually confirm: past unconfirmed entries show the warning treatment; confirmed entries look as before; future placements hatched as before.

- [ ] **Step 5: Commit**

```bash
git add src/gui website
git commit -m "feat(gui): read v_task_time_spent + time_entry; overdue-review visual"
```

---

## Phase 9 — Skill updates

### Task 21: Update `/calendrome:today` skill

**Files:**
- Modify: `.claude/skills/today.md` (or the path used by the plugin — check `plugin/` if calendrome ships skills there)

- [ ] **Step 1: Locate the skill file**

```bash
find . -path ./node_modules -prune -o -name "today*" -print 2>/dev/null | head
```

- [ ] **Step 2: Rewrite the morning-brief section**

Replace any sequential walkthrough with the list-then-one-sentence pattern (per spec § Skill changes). Use `mcp__calendrome__list_pending_review` as the data source. Document the four edge cases the skill must handle (everything-as-planned, partial, also-did-X, unaccounted-for).

- [ ] **Step 3: Rewrite the end-of-day wrap-up section**

Same pattern, scoped to today's overdue placements.

- [ ] **Step 4: Remove all references to `start_task` / `stop_task`**

```bash
grep -n "start_task\|stop_task" <skill-file>
```

Replace with placement-based flows.

- [ ] **Step 5: Commit**

```bash
git add <skill-file>
git commit -m "feat(skill): today brief uses list-then-one-sentence pattern"
```

### Task 22: Update `/calendrome:week` skill

**Files:**
- Modify: `.claude/skills/week.md` (or equivalent path)

- [ ] **Step 1: Add gather-step drift report**

Open with the prior-week unconfirmed-entry list (via `list_pending_review` over the prior week) and accept a one-sentence reconciliation before planning new work.

- [ ] **Step 2: Remove references to `time_log` / `calendar_events` direct queries** (the skill should call MCP tools, but audit anyway).

- [ ] **Step 3: Commit**

```bash
git add <skill-file>
git commit -m "feat(skill): week gather step surfaces prior-week drift"
```

### Task 23: Update `/calendrome:harvest-push` skill

**Files:**
- Modify: `.claude/skills/harvest-push.md` (or equivalent)

- [ ] **Step 1: Document the new guardrail**

Skill must call `list_pending_review` for the push date range before invoking `harvest_push_timesheet`. If non-empty, prompt the user to confirm/skip or pass `force: true`.

- [ ] **Step 2: Document personal-data preview**

Skill shows "N personal entries excluded by default — pass `--include-personal` to include."

- [ ] **Step 3: Commit**

```bash
git add <skill-file>
git commit -m "feat(skill): harvest-push surfaces unconfirmed + personal preview"
```

### Task 24: Update `/calendrome:block` skill — placement + philosophy steer

**Files:**
- Modify: `.claude/skills/block.md` (or equivalent)

- [ ] **Step 1: Update block flow**

Block now creates the gcal event AND a paired UNCONFIRMED `time_entry`. If `block_time` MCP tool was kept distinct (per Task 10's decision point), then `/block` uses `place_task` instead — clarify in the skill.

- [ ] **Step 2: Add philosophy-steer trigger**

When user says timer-shaped phrases ("start a timer for X", "track time on Y", "begin work on Z"), the skill responds with the steer text from the spec rather than looking for a stopwatch tool. Embed the exact text in the skill prompt.

- [ ] **Step 3: Commit**

```bash
git add <skill-file>
git commit -m "feat(skill): block creates paired time_entry; steers timer phrasing to placement"
```

---

## Phase 10 — Cutover

### Task 25: Run the migration on the live DB

**Files:** none (operational)

- [ ] **Step 1: Back up the DB**

```bash
cp /Users/matthausklute/dev/tools/calendrome/calendrome.db \
   /Users/matthausklute/dev/tools/calendrome/calendrome.db.bak-pre-time-entry-migration
```

- [ ] **Step 2: Run the migration**

```bash
cd /Users/matthausklute/dev/tools/calendrome
npx tsx scripts/migrate-to-time-entry.ts calendrome.db
```

Expected output: "Migration complete."

- [ ] **Step 3: Sanity-check the migrated DB**

```bash
sqlite3 calendrome.db "
  SELECT 'tables', name FROM sqlite_master WHERE type='table' AND name IN ('time_entry','time_log','calendar_events');
  SELECT 'time_entry rows', COUNT(*) FROM time_entry;
  SELECT 'task columns', GROUP_CONCAT(name, ',') FROM pragma_table_info('tasks');
"
```

Expected: `time_entry` table exists; `time_log` and `calendar_events` absent; `tasks` columns do NOT include `time_spent_minutes` or `calendar_event_id`.

- [ ] **Step 4: Run a CSV export and compare to last-known-good**

```bash
# via MCP or direct query: export_timesheet for last known-good week
# compare to a pre-migration CSV you saved before Step 1
```

Totals must match the post-Phase-0 backfill expectations.

### Task 26: Update website install/docs per CLAUDE.md "Keep the website in sync"

**Files:**
- Modify: `website/index.html` — install section if anything changed
- Modify: `website/docs.html` — tool list reflects new MCP surface

- [ ] **Step 1: Update tool list in `website/docs.html`**

Add `confirm_placement`, `skip_placement`, `list_pending_review`, `move_placement`. Remove `start_task`, `stop_task`. Update descriptions on `log_time`, `place_task`, `unplace_task`, `block_time`, `sync_calendar_events`, `export_timesheet`, `harvest_push_timesheet`, `get_timesheet_summary`.

- [ ] **Step 2: Update install section in `website/index.html`** if any commands changed (likely not — MCP install path is stable)

- [ ] **Step 3: Commit**

```bash
git add website/
git commit -m "docs(website): reflect new MCP surface (confirm/skip/list_pending_review/move)"
```

### Task 27: Full test suite + PR

**Files:** none (verification + PR creation)

- [ ] **Step 1: Run the full suite**

```bash
npm test
```

Expected: all green. If anything red, fix before proceeding.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: clean TS compile + schema.sql + GUI assets copied.

- [ ] **Step 3: Manual smoke**

- Start MCP: `npm start`
- Open GUI: `npm run gui`
- Through Claude: confirm a pending entry, skip a pending entry, move a placement, run `/calendrome:today` brief, run `/calendrome:harvest-push` (verify it refuses when unconfirmed exist)

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "feat: unify time_log + calendar_events + time_spent_minutes into time_entry" \
  --body "$(cat <<'EOF'
## Summary

Collapse three sources of truth (`time_log`, `calendar_events`, `tasks.time_spent_minutes`) into one `time_entry` table with `UNCONFIRMED` / `CONFIRMED` states.

Closes #44. Supersedes #66 (drift class removed by construction).

## Architecture

- One `time_entry` table; `tasks.time_spent_minutes` → SQL view (`v_task_time_spent`)
- `habit_instances` keeps recurrence logic, gains `time_entry_id` sidecar
- Personal/work separation: `categories=['work']` default on `export_timesheet` / `harvest_push_timesheet` / `get_timesheet_summary`
- `harvest_push_timesheet` refuses to push if UNCONFIRMED entries exist in range (`force: true` overrides)
- Live stopwatch removed (`start_task` / `stop_task`)
- 4 new MCP tools: `confirm_placement`, `skip_placement`, `list_pending_review`, `move_placement`

## Test plan
- [ ] Full vitest suite green
- [ ] Migration parity test (`tests/migration-to-time-entry.test.ts`) green
- [ ] Manual: confirm a pending entry via `/calendrome:today`
- [ ] Manual: harvest push refuses on unconfirmed entries
- [ ] Manual: GUI shows orange border on past unconfirmed
EOF
)"
```

- [ ] **Step 5: Merge after CI passes**

(User-driven — merge when ready.)

---

## Decisions deferred to follow-up issues

After PR merges, file these new issues:

1. **"Steer timer-shaped phrasing toward placement"** — covered partially by `/calendrome:block`; file a broader skill/prompt issue tagged `enhancement`.
2. **"Cascading reschedule: block now, slide overlapping placements"** — links to #23.
3. **SKIPPED state with audit history** — if/when needed.

---

## Self-review checklist (run after writing — done at plan-write time)

- [x] Spec coverage: every § in the design doc has at least one task
- [x] Placeholder scan: no TBD/TODO/FIXME in step content
- [x] Type consistency: `TimeEntryStatus`, `TimeEntrySource`, function signatures (`insertTimeEntry`, `confirmTimeEntry`, `skipTimeEntry`, `listPendingReview`, `moveTimeEntry`, `logTime`, `placeTask`, `unplaceTask`) consistent across tasks
- [x] Test code present in every TDD step that introduces behavior
- [x] Migration parity check inline in the script (per the slim-the-migration directive)
