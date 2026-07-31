/**
 * Core contract: `list_pending_review` resolves a day the same way the
 * GUI renders it.
 *
 * Reproduces the reported symptom directly — a morning brief asks for
 * yesterday, the GUI shows four blocks, the brief reports two.
 */
import { describe, it, expect } from 'vitest';
import { freshDb } from '../helpers/db.js';
import {
  guiIdsForDay,
  mcpIdsForDay,
  mcpIdsForRange,
  placement,
  seedWork,
  withTz,
} from './helpers.js';

const CHICAGO = 'America/Chicago';
const MON = '2026-07-13';
const TUE = '2026-07-14';
const SUN = '2026-07-12';

describe('local-day bucketing parity (America/Chicago)', () => {
  it('agrees on a plain daytime block (guards against over-correction)', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // 9:00-10:00am CT Mon — same calendar day in both zones.
      const id = placement(db, task, '2026-07-13T14:00:00Z', '2026-07-13T15:00:00Z');

      expect(guiIdsForDay(db, MON, MON)).toEqual([id]);
      expect(mcpIdsForDay(db, MON)).toEqual([id]);
    });
  });

  it('includes an evening block in the local day the GUI files it under', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // 7:00-9:00pm CT Mon, stored as Tuesday UTC.
      const evening = placement(db, task, '2026-07-14T00:00:00Z', '2026-07-14T02:00:00Z');

      expect(guiIdsForDay(db, MON, MON)).toEqual([evening]);
      expect(mcpIdsForDay(db, MON)).toEqual([evening]);
      expect(mcpIdsForDay(db, TUE)).toEqual([]);
    });
  });

  it('does not leak the prior local evening into the next day', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // 11:00pm-midnight CT Sun, stored as Monday UTC.
      const sunday = placement(db, task, '2026-07-13T04:00:00Z', '2026-07-13T05:00:00Z');
      // 9:00-10:00am CT Mon.
      const monday = placement(db, task, '2026-07-13T14:00:00Z', '2026-07-13T15:00:00Z');

      expect(mcpIdsForDay(db, MON)).toEqual([monday]);
      expect(mcpIdsForDay(db, SUN)).toEqual([sunday]);
    });
  });

  it('reproduces the reported symptom: a full local day, not a short one', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      const standup = placement(db, task, '2026-07-13T15:30:00Z', '2026-07-13T16:00:00Z');
      const sync = placement(db, task, '2026-07-13T16:00:00Z', '2026-07-13T17:00:00Z');
      const afternoon = placement(db, task, '2026-07-13T19:00:00Z', '2026-07-13T21:00:00Z');
      // The two that go missing today: 7pm and 9:30pm CT.
      const evening = placement(db, task, '2026-07-14T00:00:00Z', '2026-07-14T02:00:00Z');
      const lateEvening = placement(db, task, '2026-07-14T02:30:00Z', '2026-07-14T03:30:00Z');

      const expected = [standup, sync, afternoon, evening, lateEvening];
      expect(guiIdsForDay(db, MON, MON)).toEqual(expected);
      expect(mcpIdsForDay(db, MON)).toEqual(expected);
    });
  });

  it('resolves the same id set as the GUI on every day of the week', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      placement(db, task, '2026-07-13T14:00:00Z', '2026-07-13T15:00:00Z'); // Mon 9am
      placement(db, task, '2026-07-14T00:00:00Z', '2026-07-14T02:00:00Z'); // Mon 7pm
      placement(db, task, '2026-07-15T20:00:00Z', '2026-07-15T21:00:00Z'); // Wed 3pm
      placement(db, task, '2026-07-18T01:30:00Z', '2026-07-18T03:00:00Z'); // Fri 8:30pm
      placement(db, task, '2026-07-19T16:00:00Z', '2026-07-19T17:00:00Z'); // Sun 11am

      for (let i = 0; i < 7; i++) {
        const day = new Date(Date.parse(`${MON}T12:00:00Z`) + i * 86_400_000)
          .toISOString()
          .slice(0, 10);
        expect(mcpIdsForDay(db, day), `day ${day}`).toEqual(guiIdsForDay(db, MON, day));
      }
    });
  });
});

describe('range semantics under local-day bucketing', () => {
  it('covers the last local evening of a multi-day range', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      const monMorning = placement(db, task, '2026-07-13T14:00:00Z', '2026-07-13T15:00:00Z');
      // 8:30pm CT Fri 7/17, stored as Saturday UTC — the last day's tail.
      const friEvening = placement(db, task, '2026-07-18T01:30:00Z', '2026-07-18T03:00:00Z');

      expect(mcpIdsForRange(db, '2026-07-13', '2026-07-17')).toEqual([
        monMorning,
        friEvening,
      ]);
    });
  });

  it('excludes the local evening before a range starts', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // 11:00pm CT Sun 7/12, stored as Monday UTC — before the range.
      placement(db, task, '2026-07-13T04:00:00Z', '2026-07-13T05:00:00Z');
      const inRange = placement(db, task, '2026-07-13T14:00:00Z', '2026-07-13T15:00:00Z');

      expect(mcpIdsForRange(db, MON, '2026-07-17')).toEqual([inRange]);
    });
  });

  it('treats plain-date and ISO-timestamp bounds identically (#92 non-regression)', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      placement(db, task, '2026-07-13T14:00:00Z', '2026-07-13T15:00:00Z');
      placement(db, task, '2026-07-14T00:00:00Z', '2026-07-14T02:00:00Z');

      const plain = mcpIdsForRange(db, MON, MON);
      // Local-midnight bounds for the same day, offset-stamped.
      const stamped = mcpIdsForRange(
        db,
        '2026-07-13T00:00:00-05:00',
        '2026-07-13T23:59:59-05:00',
      );
      expect(stamped).toEqual(plain);
    });
  });

  it('returns nothing for an inverted range', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      placement(db, task, '2026-07-13T14:00:00Z', '2026-07-13T15:00:00Z');

      expect(mcpIdsForRange(db, '2026-07-17', MON)).toEqual([]);
    });
  });
});

describe('entries that touch a local midnight', () => {
  it('buckets a block spanning midnight by its start day', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // 11:30pm CT Mon - 12:30am CT Tue.
      const spanning = placement(db, task, '2026-07-14T04:30:00Z', '2026-07-14T05:30:00Z');

      expect(mcpIdsForDay(db, MON)).toEqual([spanning]);
      expect(mcpIdsForDay(db, TUE)).toEqual([]);
      expect(guiIdsForDay(db, MON, MON)).toEqual([spanning]);
    });
  });

  it('files a block starting exactly at local midnight on the new day', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // Exactly 00:00:00 CT Tue.
      const atMidnight = placement(db, task, '2026-07-14T05:00:00Z', '2026-07-14T06:00:00Z');

      expect(mcpIdsForDay(db, TUE)).toEqual([atMidnight]);
      expect(mcpIdsForDay(db, MON)).toEqual([]);
    });
  });

  it('files a block ending exactly at local midnight on the starting day', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      const task = seedWork(db);
      // 11:00pm CT Mon - exactly 00:00:00 CT Tue.
      const untilMidnight = placement(db, task, '2026-07-14T04:00:00Z', '2026-07-14T05:00:00Z');

      expect(mcpIdsForDay(db, MON)).toEqual([untilMidnight]);
      expect(mcpIdsForDay(db, TUE)).toEqual([]);
    });
  });
});
