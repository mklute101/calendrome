import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { freshDb } from './helpers/db.js';
import type { DB } from '../src/db/connection.js';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createTask } from '../src/tasks.js';
import { createHabit } from '../src/habits.js';
import { createGoal } from '../src/goals.js';
import { insertTimeEntry } from '../src/time-entry.js';
import { createApp } from '../src/gui/server.js';
import { FakeCalendarClient } from '../src/calendar/index.js';
import { buildTools } from '../src/mcp/tools/index.js';
import {
  runHealthChecks,
  CANONICAL_GLOB,
  checkTimeEntryCanonicalUtc,
  checkHabitTimezoneNotUtc,
  checkTaskDueNotPlacementWritten,
  checkPlacementBackingCommitment,
  checkCalendarEventIdUnique,
} from '../src/health/checks.js';
import { CANONICAL_UTC } from '../src/day-range.js';

/**
 * Invariant health checks (#164): every check gets a deliberately
 * corrupted fixture proving it fails and a clean fixture proving it
 * passes, plus a parity test that the `check_health` MCP tool and
 * `GET /api/health` return identical results for the same database.
 */

function seedProject(db: DB): void {
  db.prepare(
    `INSERT INTO projects (id, name, prefix) VALUES ('acme', 'Acme', 'ACME')`,
  ).run();
}

/** Insert a raw time_entry row, bypassing insertTimeEntry's normalization. */
function rawEntry(
  db: DB,
  cols: Record<string, string | number | null>,
): void {
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO time_entry (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`,
  ).run(...Object.values(cols));
}

describe('checkTimeEntryCanonicalUtc', () => {
  it('passes on canonical UTC timestamps', () => {
    const db = freshDb();
    seedProject(db);
    insertTimeEntry(db, {
      project_id: 'acme',
      start_at: '2026-07-13T09:00:00Z',
      end_at: '2026-07-13T10:00:00Z',
      status: 'CONFIRMED',
      source: 'manual',
    });
    expect(checkTimeEntryCanonicalUtc(db).ok).toBe(true);
  });

  it('fails on offset-stamped and fractional-second rows', () => {
    const db = freshDb();
    seedProject(db);
    // Written before #95: an evening local-time stamp whose UTC day
    // bucket (DATE() → next day) disagrees with the written local day.
    rawEntry(db, {
      project_id: 'acme',
      start_at: '2026-07-06T19:15:00-05:00',
      end_at: '2026-07-06T20:15:00-05:00',
      status: 'CONFIRMED',
      source: 'manual',
    });
    rawEntry(db, {
      project_id: 'acme',
      start_at: '2026-07-07T09:00:00.000Z',
      end_at: '2026-07-07T10:00:00.000Z',
      status: 'CONFIRMED',
      source: 'manual',
    });
    const result = checkTimeEntryCanonicalUtc(db);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/2 time_entry row\(s\)/);
  });

  it('keeps CANONICAL_GLOB in agreement with CANONICAL_UTC (day-range.ts)', () => {
    // The check restates the canonical form as a SQL GLOB because a
    // regex cannot run inside a WHERE clause. This guard evaluates
    // both against every timestamp shape the write paths have
    // produced, so a change to the canonical form in day-range.ts
    // cannot silently drift past the health check.
    const db = freshDb();
    const glob = db.prepare(`SELECT (? GLOB ?) AS m`);
    const samples = [
      '2026-07-13T09:00:00Z', // canonical
      '2026-07-06T19:15:00-05:00', // offset-stamped (#95)
      '2026-07-07T09:00:00.000Z', // fractional seconds (#95)
      '2026-07-13t09:00:00z', // lowercase separator/suffix
      '2026-07-13', // plain date
      '2026-07-13 09:00:00', // space-separated SQLite form
      '2026-07-13T09:00:00', // zoneless
      '2026-07-13T09:00Z', // minute precision
    ];
    for (const value of samples) {
      const viaGlob = (glob.get(value, CANONICAL_GLOB) as { m: number }).m === 1;
      expect(viaGlob, value).toBe(CANONICAL_UTC.test(value));
    }
  });
});

describe('checkHabitTimezoneNotUtc', () => {
  it('passes when active habits carry a real timezone', () => {
    const db = freshDb();
    seedProject(db);
    createHabit(db, {
      project_id: 'acme',
      title: 'Morning run',
      duration_minutes: 30,
      days_of_week: '1,3,5',
      start_time: '07:00',
      timezone: 'America/Chicago',
    });
    expect(checkHabitTimezoneNotUtc(db).ok).toBe(true);
  });

  it('fails when an active habit is left on the default UTC timezone', () => {
    const db = freshDb();
    seedProject(db);
    const habit = createHabit(db, {
      project_id: 'acme',
      title: 'Stretching',
      duration_minutes: 15,
      days_of_week: '2,4',
      start_time: '07:00',
      // timezone omitted -> schema default 'UTC' leaks through
    });
    const result = checkHabitTimezoneNotUtc(db);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`id ${habit.id}`);

    // Deactivated habits stop counting against the invariant.
    db.prepare(`UPDATE habits SET active = 0 WHERE id = ?`).run(habit.id);
    expect(checkHabitTimezoneNotUtc(db).ok).toBe(true);
  });
});

describe('checkTaskDueNotPlacementWritten', () => {
  it('passes on deliberate dues (plain date, or timestamp not matching a placement)', () => {
    const db = freshDb();
    seedProject(db);
    const dated = createTask(db, {
      project_id: 'acme',
      title: 'Plain-date due',
      due: '2026-07-20',
    });
    insertTimeEntry(db, {
      task_id: dated.id,
      project_id: 'acme',
      start_at: '2026-07-13T09:00:00Z',
      end_at: '2026-07-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
      external_id: 'evt-clean-1',
    });
    const timed = createTask(db, {
      project_id: 'acme',
      title: 'Deliberate timestamp due',
      due: '2026-07-20T17:00:00Z',
    });
    insertTimeEntry(db, {
      task_id: timed.id,
      project_id: 'acme',
      start_at: '2026-07-14T09:00:00Z',
      end_at: '2026-07-14T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
      external_id: 'evt-clean-2',
    });
    expect(checkTaskDueNotPlacementWritten(db).ok).toBe(true);
  });

  it('fails when a due equals a placement start (stale pre-#79 write)', () => {
    const db = freshDb();
    seedProject(db);
    const task = createTask(db, { project_id: 'acme', title: 'Stale due' });
    insertTimeEntry(db, {
      task_id: task.id,
      project_id: 'acme',
      start_at: '2026-07-13T09:00:00Z',
      end_at: '2026-07-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
      external_id: 'evt-stale-1',
    });
    // The old place_task wrote its raw start argument into due —
    // offset form here, canonical UTC in the time_entry row.
    db.prepare(`UPDATE tasks SET due = ? WHERE id = ?`).run(
      '2026-07-13T04:00:00-05:00',
      task.id,
    );
    const result = checkTaskDueNotPlacementWritten(db);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`id ${task.id}`);
  });
});

describe('checkPlacementBackingCommitment', () => {
  it('passes when placements reference an existing task or goal', () => {
    const db = freshDb();
    seedProject(db);
    const task = createTask(db, { project_id: 'acme', title: 'Backed' });
    insertTimeEntry(db, {
      task_id: task.id,
      project_id: 'acme',
      start_at: '2026-07-13T09:00:00Z',
      end_at: '2026-07-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });
    const goal = createGoal(db, {
      project_id: 'acme',
      title: 'Bucket',
      target_minutes: 600,
      refill_period: 'week',
    });
    insertTimeEntry(db, {
      goal_id: goal.id,
      project_id: 'acme',
      start_at: '2026-07-13T11:00:00Z',
      end_at: '2026-07-13T12:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });
    expect(checkPlacementBackingCommitment(db).ok).toBe(true);
  });

  it('fails on placements with a dangling task_id or no link at all', () => {
    const db = freshDb();
    seedProject(db);
    // Dangling reference: only insertable with foreign keys off, which
    // is exactly how a legacy or hand-edited DB gets into this state.
    db.pragma('foreign_keys = OFF');
    rawEntry(db, {
      task_id: 999,
      project_id: 'acme',
      start_at: '2026-07-13T09:00:00Z',
      end_at: '2026-07-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });
    db.pragma('foreign_keys = ON');
    // No link at all: neither task_id nor goal_id.
    rawEntry(db, {
      project_id: 'acme',
      start_at: '2026-07-14T09:00:00Z',
      end_at: '2026-07-14T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });
    const result = checkPlacementBackingCommitment(db);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/2 placement time_entry row\(s\)/);
  });
});

describe('checkCalendarEventIdUnique', () => {
  it('passes on distinct external ids (NULLs do not collide)', () => {
    const db = freshDb();
    seedProject(db);
    insertTimeEntry(db, {
      project_id: 'acme',
      start_at: '2026-07-13T09:00:00Z',
      end_at: '2026-07-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'gcal-sync',
      external_id: 'evt-1',
    });
    insertTimeEntry(db, {
      project_id: 'acme',
      start_at: '2026-07-13T11:00:00Z',
      end_at: '2026-07-13T12:00:00Z',
      status: 'UNCONFIRMED',
      source: 'gcal-sync',
      external_id: 'evt-2',
    });
    insertTimeEntry(db, {
      project_id: 'acme',
      start_at: '2026-07-13T13:00:00Z',
      end_at: '2026-07-13T14:00:00Z',
      status: 'CONFIRMED',
      source: 'manual',
    });
    expect(checkCalendarEventIdUnique(db).ok).toBe(true);
  });

  it('fails on duplicate external ids (legacy DB without the unique index)', () => {
    const db = freshDb();
    seedProject(db);
    db.prepare(`DROP INDEX idx_time_entry_external`).run();
    for (const start of ['2026-07-13T09:00:00Z', '2026-07-13T11:00:00Z']) {
      rawEntry(db, {
        project_id: 'acme',
        start_at: start,
        end_at: start.replace('T09', 'T10').replace('T11', 'T12'),
        status: 'UNCONFIRMED',
        source: 'gcal-sync',
        external_id: 'evt-dupe',
      });
    }
    const result = checkCalendarEventIdUnique(db);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('evt-dupe');
  });
});

describe('runHealthChecks', () => {
  it('reports ok with zero failing on a clean database', () => {
    const db = freshDb();
    seedProject(db);
    const report = runHealthChecks(db);
    expect(report.ok).toBe(true);
    expect(report.failing).toBe(0);
    expect(report.db).toBe(':memory:');
    expect(report.checks).toHaveLength(5);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it('flips ok and counts failures when an invariant breaks', () => {
    const db = freshDb();
    seedProject(db);
    createHabit(db, {
      project_id: 'acme',
      title: 'UTC habit',
      duration_minutes: 30,
      days_of_week: '1',
      start_time: '07:00',
    });
    const report = runHealthChecks(db);
    expect(report.ok).toBe(false);
    expect(report.failing).toBe(1);
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed.map((c) => c.name)).toEqual(['habit_timezone_not_utc']);
  });
});

describe('health surfaces parity', () => {
  it('check_health tool and GET /api/health return identical results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendrome-health-'));
    let server: Server | undefined;
    try {
      const dbPath = join(dir, 'calendrome.db');
      const setup = openDatabase(dbPath);
      migrate(setup);
      seedProject(setup);
      // One deliberate failure so the parity covers a non-trivial report.
      createHabit(setup, {
        project_id: 'acme',
        title: 'UTC habit',
        duration_minutes: 30,
        days_of_week: '1',
        start_time: '07:00',
      });
      setup.close();

      const app = createApp(dbPath, new FakeCalendarClient());
      const listening = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      server = listening;
      const addr = listening.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      // node fetch types return `unknown` from json(); the assertions
      // below are the contract here (same convention as gui-http.test.ts).
      const httpReport = (await (
        await fetch(`http://127.0.0.1:${addr.port}/api/health`)
      ).json()) as any;

      const mcpDb = openDatabase(dbPath);
      try {
        const tool = buildTools(mcpDb).find((t) => t.name === 'check_health');
        if (!tool) throw new Error('check_health tool not found');
        const mcpReport = await tool.handler({});

        expect(mcpReport).toEqual(httpReport);
        expect(httpReport.ok).toBe(false);
        expect(httpReport.failing).toBe(1);
        expect(httpReport.db).toBe(dbPath);
      } finally {
        mcpDb.close();
      }
    } finally {
      if (server) await new Promise((resolve) => server!.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
