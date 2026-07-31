/**
 * What the day-bucketing split costs once it leaves the read layer.
 *
 * Two consequences that are worse than a short morning brief:
 *   1. Harvest entries get billed to the wrong calendar day.
 *   2. The calendar-sync prune deletes meetings the payload never
 *      claimed to cover.
 *
 * Both are downstream of the same UTC-vs-local question, so both belong
 * to the definition of "fixed".
 */
import { describe, it, expect, vi } from 'vitest';
import { freshDb } from '../helpers/db.js';
import { createProject } from '../../src/projects.js';
import { createTask } from '../../src/tasks.js';
import { harvestPushTimesheet } from '../../src/harvest/push.js';
import { syncCalendarEvents } from '../../src/calendar-sync.js';
import type { HarvestClient } from '../../src/harvest/client.js';
import { insertTimeEntry } from '../../src/time-entry.js';
import { confirmed, meeting, seedWork, withTz } from './helpers.js';

const CHICAGO = 'America/Chicago';
const MON = '2026-07-13';
const FRI = '2026-07-17';

/** 7:00-9:00pm CT Mon 7/13, stored as Tuesday UTC. */
const EVENING_START = '2026-07-14T00:00:00Z';
const EVENING_END = '2026-07-14T02:00:00Z';

function mockClient(): HarvestClient {
  let nextId = 1000;
  return {
    createTimeEntry: vi.fn(async () => ({
      id: nextId++,
      project: { id: 1, name: 'P' },
      task: { id: 1, name: 'T' },
      spent_date: '',
      hours: 0,
      notes: null,
    })),
    updateTimeEntry: vi.fn(async () => ({
      id: 1,
      project: { id: 1, name: 'P' },
      task: { id: 1, name: 'T' },
      spent_date: '',
      hours: 0,
      notes: null,
    })),
    listTimeEntries: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
  } as unknown as HarvestClient;
}

function seedBillable(db: any) {
  createProject(db, {
    id: 'acme',
    name: 'Acme Corp',
    prefix: 'ACME',
    harvest_project_id: 101,
    harvest_task_id: 202,
  });
  return createTask(db, { project_id: 'acme', title: 'Report' }).id;
}

describe('Harvest push bills work to the local day', () => {
  it('sends an evening entry with its local spent_date', async () => {
    await withTz(CHICAGO, async () => {
      const db = freshDb();
      const task = seedBillable(db);
      confirmed(db, task, EVENING_START, EVENING_END, 120, 'acme');

      const client = mockClient();
      const result = await harvestPushTimesheet(db, client, MON, FRI);

      expect(result.pushed).toBe(1);
      // start_at.slice(0, 10) says 2026-07-14. The work happened Monday.
      expect(client.createTimeEntry).toHaveBeenCalledWith(
        expect.objectContaining({ spent_date: MON }),
      );
    });
  });

  it('includes the last local day of the push range', async () => {
    await withTz(CHICAGO, async () => {
      const db = freshDb();
      const task = seedBillable(db);
      // 8:30pm CT Fri 7/17, stored as Saturday UTC — the final evening
      // of the week being invoiced.
      confirmed(db, task, '2026-07-18T01:30:00Z', '2026-07-18T03:00:00Z', 90, 'acme');

      const client = mockClient();
      const result = await harvestPushTimesheet(db, client, MON, FRI);

      expect(result.pushed).toBe(1);
      expect(client.createTimeEntry).toHaveBeenCalledWith(
        expect.objectContaining({ spent_date: FRI }),
      );
    });
  });

  it('excludes work from the local evening before the range', async () => {
    await withTz(CHICAGO, async () => {
      const db = freshDb();
      const task = seedBillable(db);
      // 11:00pm CT Sun 7/12 — belongs to the previous week's invoice.
      confirmed(db, task, '2026-07-13T04:00:00Z', '2026-07-13T05:00:00Z', 60, 'acme');

      const client = mockClient();
      const result = await harvestPushTimesheet(db, client, MON, FRI);

      expect(result.pushed).toBe(0);
      expect(client.createTimeEntry).not.toHaveBeenCalled();
    });
  });

  it('pre-flight guard catches an unconfirmed entry on the last local evening', async () => {
    await withTz(CHICAGO, async () => {
      const db = freshDb();
      const task = seedBillable(db);
      confirmed(db, task, '2026-07-13T14:00:00Z', '2026-07-13T15:00:00Z', 60, 'acme');
      // Unconfirmed Friday-evening block: must block the push rather
      // than let unreviewed hours slip past the guard's range.
      insertTimeEntry(db, {
        task_id: task,
        project_id: 'acme',
        start_at: '2026-07-18T01:30:00Z',
        end_at: '2026-07-18T03:00:00Z',
        status: 'UNCONFIRMED',
        source: 'placement',
      });

      const client = mockClient();
      await expect(harvestPushTimesheet(db, client, MON, FRI)).rejects.toThrow();
      expect(client.createTimeEntry).not.toHaveBeenCalled();
    });
  });
});

describe('calendar-sync prune respects local-day windows', () => {
  it('does not delete a meeting from the local day before the window', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      seedWork(db);
      // 11:00pm CT Sun 7/12, stored as Monday UTC. A Mon-Fri local sync
      // payload never covers it, so pruning it is data loss.
      meeting(db, '2026-07-13T04:00:00Z', '2026-07-13T05:00:00Z', 'evt-sunday-night');

      const result = syncCalendarEvents(
        db,
        [
          {
            id: 'evt-monday',
            calendar_id: 'primary',
            summary: 'Standup',
            start: '2026-07-13T15:30:00Z',
            end: '2026-07-13T16:00:00Z',
            is_meeting: true,
          },
        ],
        { from: MON, to: FRI },
      );

      expect(result.pruned_events.map((e) => e.id)).toEqual([]);
      expect(result.deleted).toBe(0);
      const survivors = db
        .prepare(`SELECT external_id FROM time_entry WHERE source = 'gcal-sync' ORDER BY start_at`)
        .all() as { external_id: string }[];
      expect(survivors.map((r) => r.external_id)).toContain('evt-sunday-night');
    });
  });

  it('still prunes a cancelled meeting inside the local window', async () => {
    await withTz(CHICAGO, () => {
      const db = freshDb();
      seedWork(db);
      // 7:00pm CT Mon 7/13 — inside the window locally, and genuinely
      // absent from the payload.
      meeting(db, EVENING_START, EVENING_END, 'evt-cancelled');

      const result = syncCalendarEvents(
        db,
        [
          {
            id: 'evt-monday',
            calendar_id: 'primary',
            summary: 'Standup',
            start: '2026-07-13T15:30:00Z',
            end: '2026-07-13T16:00:00Z',
            is_meeting: true,
          },
        ],
        { from: MON, to: FRI },
      );

      expect(result.pruned_events.map((e) => e.id)).toEqual(['evt-cancelled']);
      expect(result.deleted).toBe(1);
    });
  });
});
