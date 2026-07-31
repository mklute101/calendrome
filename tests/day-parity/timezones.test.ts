/**
 * The bug is not "US evenings" — it is any offset from UTC, in either
 * direction, including the fractional-hour ones.
 *
 * UTC- zones push evening work onto tomorrow's UTC day. UTC+ zones do
 * the mirror image: early-morning work lands on yesterday's UTC day, so
 * a UTC+ user loses the *start* of their day rather than the end.
 *
 * The UTC case is the non-regression guard. It is also why this class
 * of bug survives CI: with TZ=UTC every assertion below passes against
 * the broken implementation.
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

const MON = '2026-07-13';
const TUE = '2026-07-14';

/** Zones whose local day differs from the UTC day for the given instant. */
const AHEAD_OF_UTC = [
  // [zone, stored UTC instant, local wall time it represents]
  ['Asia/Tokyo', '2026-07-13T23:00:00Z', '08:00 Tue'],
  ['Asia/Kolkata', '2026-07-13T21:30:00Z', '03:00 Tue (half-hour offset)'],
  ['Asia/Kathmandu', '2026-07-13T23:15:00Z', '05:00 Tue (45-minute offset)'],
  ['Australia/Sydney', '2026-07-13T23:00:00Z', '09:00 Tue (southern hemisphere)'],
  ['Europe/Berlin', '2026-07-13T22:30:00Z', '00:30 Tue'],
  ['Pacific/Kiritimati', '2026-07-13T11:00:00Z', '01:00 Tue (UTC+14)'],
] as const;

describe('UTC+ zones: the mirror-image bug', () => {
  for (const [zone, instant, wall] of AHEAD_OF_UTC) {
    it(`${zone}: a ${wall} entry belongs to the local day, not the UTC one`, async () => {
      await withTz(zone, () => {
        const db = freshDb();
        const task = seedWork(db);
        const end = new Date(Date.parse(instant) + 3_600_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z');
        const id = placement(db, task, instant, end);

        // Sanity: the fixture really does straddle the date line for
        // this zone, otherwise the test proves nothing.
        expect(localDay(instant)).toBe(TUE);
        expect(instant.slice(0, 10)).toBe(MON);

        expect(mcpIdsForDay(db, TUE)).toEqual([id]);
        expect(mcpIdsForDay(db, MON)).toEqual([]);
      });
    });
  }

  it('Asia/Tokyo: a full local day survives the round trip to the GUI', async () => {
    await withTz('Asia/Tokyo', () => {
      const db = freshDb();
      const task = seedWork(db);
      const morning = placement(db, task, '2026-07-13T23:00:00Z', '2026-07-14T00:00:00Z');
      const midday = placement(db, task, '2026-07-14T03:00:00Z', '2026-07-14T04:00:00Z');
      const evening = placement(db, task, '2026-07-14T09:00:00Z', '2026-07-14T10:00:00Z');

      const expected = [morning, midday, evening];
      expect(guiIdsForDay(db, MON, TUE)).toEqual(expected);
      expect(mcpIdsForDay(db, TUE)).toEqual(expected);
    });
  });
});

describe('UTC: nothing moves (non-regression)', () => {
  it('buckets every entry on its stored UTC day', async () => {
    await withTz('UTC', () => {
      const db = freshDb();
      const task = seedWork(db);
      const monMorning = placement(db, task, '2026-07-13T09:00:00Z', '2026-07-13T10:00:00Z');
      const monLate = placement(db, task, '2026-07-13T23:30:00Z', '2026-07-14T00:30:00Z');
      const tueMidnight = placement(db, task, '2026-07-14T00:00:00Z', '2026-07-14T01:00:00Z');

      expect(mcpIdsForDay(db, MON)).toEqual([monMorning, monLate]);
      expect(mcpIdsForDay(db, TUE)).toEqual([tueMidnight]);
      expect(guiIdsForDay(db, MON, MON)).toEqual([monMorning, monLate]);
      expect(guiIdsForDay(db, MON, TUE)).toEqual([tueMidnight]);
    });
  });
});

describe('the same database read from two zones', () => {
  it('answers according to the zone doing the asking', async () => {
    // One instant: 7:00pm CT Mon == 09:00 JST Tue. Neither answer is
    // wrong — "which day" is a property of the viewer, which is exactly
    // why the read side cannot hardcode UTC.
    const instant = '2026-07-14T00:00:00Z';

    await withTz('America/Chicago', () => {
      const db = freshDb();
      const task = seedWork(db);
      const id = placement(db, task, instant, '2026-07-14T01:00:00Z');
      expect(mcpIdsForDay(db, MON)).toEqual([id]);
      expect(mcpIdsForDay(db, TUE)).toEqual([]);
    });

    await withTz('Asia/Tokyo', () => {
      const db = freshDb();
      const task = seedWork(db);
      const id = placement(db, task, instant, '2026-07-14T01:00:00Z');
      expect(mcpIdsForDay(db, TUE)).toEqual([id]);
      expect(mcpIdsForDay(db, MON)).toEqual([]);
    });
  });
});
