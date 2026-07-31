/**
 * Daylight-saving transitions, where a local "day" is not 24 hours.
 *
 * These exist to reject the tempting shortcut fix: capturing the
 * current UTC offset once and subtracting it. That passes every test in
 * local-day.test.ts and still corrupts two days a year — and it fails
 * in the direction that loses billable evening work.
 *
 * America/Chicago 2026:
 *   spring forward  Sun Mar  8 -> local day is 23h (06:00Z .. 04:59Z)
 *   fall back       Sun Nov  1 -> local day is 25h (05:00Z .. 05:59Z)
 */
import { describe, it, expect } from 'vitest';
import { freshDb } from '../helpers/db.js';
import {
  guiIdsForDay,
  localDay,
  mcpIdsForDay,
  placement,
  seedWork,
  withTz,
} from './helpers.js';

const CHICAGO = 'America/Chicago';

describe('spring forward: the 23-hour local day (Sun 2026-03-08)', () => {
  it('sanity-checks the transition is where the test assumes', async () => {
    await withTz(CHICAGO, () => {
      // 01:30 CST, then the clock jumps 02:00 -> 03:00 CDT.
      expect(localDay('2026-03-08T07:30:00Z')).toBe('2026-03-08');
      expect(new Date('2026-03-08T07:30:00Z').getHours()).toBe(1);
      expect(new Date('2026-03-08T08:30:00Z').getHours()).toBe(3);
    });
  });

  it('keeps the last local hour of the short day on that day', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // 11:00-11:59pm CDT Sun 3/8 — stored on Monday UTC.
      const lateSunday = placement(db, task, '2026-03-09T04:00:00Z', '2026-03-09T04:59:00Z');
      // 12:30am CDT Mon 3/9.
      const earlyMonday = placement(db, task, '2026-03-09T05:30:00Z', '2026-03-09T06:30:00Z');

      expect(mcpIdsForDay(db, '2026-03-08')).toEqual([lateSunday]);
      expect(mcpIdsForDay(db, '2026-03-09')).toEqual([earlyMonday]);
    });
  });

  it('brackets the skipped hour without dropping either side', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // 01:30 CST (before the jump) and 03:30 CDT (after it). 02:30
      // local never existed on this date.
      const before = placement(db, task, '2026-03-08T07:30:00Z', '2026-03-08T08:00:00Z');
      const after = placement(db, task, '2026-03-08T08:30:00Z', '2026-03-08T09:30:00Z');

      expect(mcpIdsForDay(db, '2026-03-08')).toEqual([before, after]);
      expect(guiIdsForDay(db, '2026-03-02', '2026-03-08')).toEqual([before, after]);
    });
  });
});

describe('fall back: the 25-hour local day (Sun 2026-11-01)', () => {
  it('sanity-checks the repeated hour', async () => {
    await withTz(CHICAGO, () => {
      // 01:30 happens twice — once CDT, once CST — both on Nov 1.
      expect(new Date('2026-11-01T06:30:00Z').getHours()).toBe(1);
      expect(new Date('2026-11-01T07:30:00Z').getHours()).toBe(1);
      expect(localDay('2026-11-01T06:30:00Z')).toBe('2026-11-01');
      expect(localDay('2026-11-01T07:30:00Z')).toBe('2026-11-01');
    });
  });

  it('keeps both passes of the repeated hour on the same local day', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      const firstPass = placement(db, task, '2026-11-01T06:30:00Z', '2026-11-01T07:00:00Z');
      const secondPass = placement(db, task, '2026-11-01T07:30:00Z', '2026-11-01T08:00:00Z');

      expect(mcpIdsForDay(db, '2026-11-01')).toEqual([firstPass, secondPass]);
      expect(mcpIdsForDay(db, '2026-10-31')).toEqual([]);
      expect(mcpIdsForDay(db, '2026-11-02')).toEqual([]);
    });
  });

  it('keeps the 25th hour on the long day, not the next one', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // 11:30pm CST Sun 11/1 — stored on Monday UTC, still Sunday local.
      const lateSunday = placement(db, task, '2026-11-02T05:30:00Z', '2026-11-02T06:00:00Z');
      // 12:30am CST Mon 11/2.
      const earlyMonday = placement(db, task, '2026-11-02T06:30:00Z', '2026-11-02T07:30:00Z');

      expect(mcpIdsForDay(db, '2026-11-01')).toEqual([lateSunday]);
      expect(mcpIdsForDay(db, '2026-11-02')).toEqual([earlyMonday]);
    });
  });

  it('a fixed-offset fix would fail here (regression canary)', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // Two entries an hour apart across the transition. A fix that
      // captured one offset for the whole range puts them on different
      // days; correct local bucketing keeps both on Nov 1.
      const a = placement(db, task, '2026-11-01T05:30:00Z', '2026-11-01T06:00:00Z');
      const b = placement(db, task, '2026-11-02T05:30:00Z', '2026-11-02T06:00:00Z');

      expect(mcpIdsForDay(db, '2026-11-01')).toEqual([a, b]);
    });
  });
});

describe('southern-hemisphere DST runs the other way', () => {
  it('Australia/Sydney: April transition keeps evening work on its local day', async () => {
    await withTz('Australia/Sydney', () => {
      const db = freshDb();
      const task = seedWork(db);
      // Sydney leaves DST on Sun 2026-04-05 (UTC+11 -> UTC+10).
      // 09:00 local Mon 4/6 is 23:00Z Sun 4/5.
      const mondayMorning = placement(db, task, '2026-04-05T23:00:00Z', '2026-04-06T00:00:00Z');
      expect(localDay('2026-04-05T23:00:00Z')).toBe('2026-04-06');

      expect(mcpIdsForDay(db, '2026-04-06')).toEqual([mondayMorning]);
      expect(mcpIdsForDay(db, '2026-04-05')).toEqual([]);
    });
  });
});
