/**
 * Every read surface has to move together.
 *
 * #92 was exactly this failure at a smaller scale: two read tools
 * disagreeing about the same range on the same DB. Fixing
 * `list_pending_review` alone would recreate it — the brief would then
 * disagree with the timesheet, and the week view with both.
 *
 * These tests assert agreement between tools rather than hardcoding one
 * tool's answer, so they stay meaningful whichever way the fix routes
 * the timezone through.
 */
import { describe, it, expect } from 'vitest';
import { freshDb } from '../helpers/db.js';
import { getTimesheetSummary, exportTimesheet } from '../../src/timesheet.js';
import { buildTools } from '../../src/mcp/tools/index.js';
import {
  confirmed,
  guiIdsForDay,
  mcpIdsForDay,
  meeting,
  placement,
  seedWork,
  withTz,
} from './helpers.js';

const CHICAGO = 'America/Chicago';
const MON = '2026-07-13';
const TUE = '2026-07-14';

/** 7:00-9:00pm CT Mon 7/13, stored as Tuesday UTC. */
const EVENING_START = '2026-07-14T00:00:00Z';
const EVENING_END = '2026-07-14T02:00:00Z';
/** 9:00-10:00am CT Mon 7/13. */
const MORNING_START = '2026-07-13T14:00:00Z';
const MORNING_END = '2026-07-13T15:00:00Z';

async function weekLayoutStarts(db: any, from: string, to: string) {
  const tools = buildTools(db);
  const layout = tools.find((t) => t.name === 'get_week_layout')!;
  const result = (await layout.handler({ from, to })) as {
    placements: { start_at: string }[];
  };
  return result.placements.map((p) => p.start_at);
}

describe('get_week_layout agrees with list_pending_review', () => {
  it('includes Monday-evening placements when asked for Monday', async () => {
    await withTz(CHICAGO, async () => {
      const db = freshDb();
      const task = seedWork(db);
      placement(db, task, MORNING_START, MORNING_END);
      placement(db, task, EVENING_START, EVENING_END);

      expect(await weekLayoutStarts(db, MON, MON)).toEqual([
        MORNING_START,
        EVENING_START,
      ]);
    });
  });

  it('does not pull the prior local evening into a Monday-start week', async () => {
    await withTz(CHICAGO, async () => {
      const db = freshDb();
      const task = seedWork(db);
      // 11:00pm CT Sun 7/12, stored as Monday UTC.
      placement(db, task, '2026-07-13T04:00:00Z', '2026-07-13T05:00:00Z');
      placement(db, task, MORNING_START, MORNING_END);

      expect(await weekLayoutStarts(db, MON, '2026-07-19')).toEqual([MORNING_START]);
    });
  });
});

describe('get_timesheet_summary agrees with the other surfaces', () => {
  it('labels a confirmed evening entry with its local day', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      confirmed(db, task, EVENING_START, EVENING_END, 120);

      const summary = getTimesheetSummary(db, MON, MON);
      // The `date` column is what lands in the CSV a client sees.
      expect(summary.rows.map((r) => r.date)).toEqual([MON]);
      expect(summary.grand_total_hours).toBe(2);
    });
  });

  it('resolves the identical UNCONFIRMED set as list_pending_review', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      placement(db, task, MORNING_START, MORNING_END, 'morning');
      placement(db, task, EVENING_START, EVENING_END, 'evening');
      // Belongs to Sunday locally — must be absent from both.
      placement(db, task, '2026-07-13T04:00:00Z', '2026-07-13T05:00:00Z', 'sunday night');

      const summary = getTimesheetSummary(db, MON, MON, { include_unconfirmed: true });
      expect(summary.unconfirmed!.rows.map((r) => r.notes).sort()).toEqual([
        'evening',
        'morning',
      ]);
      expect(mcpIdsForDay(db, MON)).toHaveLength(2);
    });
  });

  it('keeps a whole local day inside a single-day export', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      confirmed(db, task, MORNING_START, MORNING_END, 60);
      confirmed(db, task, EVENING_START, EVENING_END, 120);

      const csv = exportTimesheet(db, MON, MON);
      const dayCells = csv
        .trim()
        .split('\n')
        .slice(1)
        .map((line) => line.split(',')[0]);
      expect(dayCells).toEqual([MON, MON]);
    });
  });
});

describe('the GUI and the MCP resolve one shared answer', () => {
  it('agrees across a week containing edge entries in both directions', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      placement(db, task, '2026-07-13T04:00:00Z', '2026-07-13T05:00:00Z'); // Sun 11pm
      placement(db, task, MORNING_START, MORNING_END); // Mon 9am
      placement(db, task, EVENING_START, EVENING_END); // Mon 7pm
      placement(db, task, '2026-07-18T01:30:00Z', '2026-07-18T03:00:00Z'); // Fri 8:30pm
      placement(db, task, '2026-07-20T02:00:00Z', '2026-07-20T03:00:00Z'); // Sun 9pm

      for (let i = 0; i < 7; i++) {
        const day = new Date(Date.parse(`${MON}T12:00:00Z`) + i * 86_400_000)
          .toISOString()
          .slice(0, 10);
        expect(mcpIdsForDay(db, day), `day ${day}`).toEqual(guiIdsForDay(db, MON, day));
      }
    });
  });
});

describe('synced meetings bucket by local day too', () => {
  // The brief confirms meeting time, so gcal-sync rows come back from
  // list_pending_review even though the GUI renders them in its own
  // calendar_events lane rather than as placements. Different lane,
  // same day question.
  it('files an evening meeting under the local day', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      seedWork(db);
      const evening = meeting(db, EVENING_START, EVENING_END, 'evt-evening');

      expect(mcpIdsForDay(db, MON)).toEqual([evening]);
      expect(mcpIdsForDay(db, TUE)).toEqual([]);
    });
  });

  it('keeps meetings and placements on the same day as each other', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      const block = placement(db, task, EVENING_START, EVENING_END);
      const sync = meeting(db, '2026-07-14T02:00:00Z', '2026-07-14T02:30:00Z', 'evt-late');

      expect(mcpIdsForDay(db, MON)).toEqual([block, sync]);
    });
  });
});
