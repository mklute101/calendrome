import { describe, it, expect, vi } from 'vitest';
import { freshDb } from '../helpers/db.js';
import { createProject } from '../../src/projects.js';
import { createTask } from '../../src/tasks.js';
import { insertTimeEntry } from '../../src/time-entry.js';
import { harvestPushTimesheet } from '../../src/harvest/push.js';
import type { HarvestClient } from '../../src/harvest/client.js';

function seedConfirmed(
  db: any,
  taskId: number | null,
  projectId: string | null,
  startedAt: string,
  durationMinutes: number,
  extras: { harvest_entry_id?: number; notes?: string } = {},
) {
  const start = new Date(startedAt);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  return insertTimeEntry(db, {
    task_id: taskId,
    project_id: projectId,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    actual_minutes: durationMinutes,
    status: 'CONFIRMED',
    confirmed_at: end.toISOString(),
    source: 'manual',
    harvest_entry_id: extras.harvest_entry_id ?? null,
    notes: extras.notes ?? null,
  });
}

function seedUnconfirmed(
  db: any,
  taskId: number | null,
  projectId: string | null,
  startedAt: string,
  durationMinutes: number,
) {
  const start = new Date(startedAt);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  return insertTimeEntry(db, {
    task_id: taskId,
    project_id: projectId,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    actual_minutes: durationMinutes,
    status: 'UNCONFIRMED',
    source: 'placement',
  });
}

function mockClient(): HarvestClient {
  let nextId = 1000;
  return {
    createTimeEntry: vi.fn(async () => ({ id: nextId++, project: { id: 1, name: 'P' }, task: { id: 1, name: 'T' }, spent_date: '', hours: 0, notes: null })),
    updateTimeEntry: vi.fn(async () => ({ id: 1, project: { id: 1, name: 'P' }, task: { id: 1, name: 'T' }, spent_date: '', hours: 0, notes: null })),
    listTimeEntries: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
  } as unknown as HarvestClient;
}

describe('harvestPushTimesheet', () => {
  it('pushes unmapped entries and stores harvest_entry_id', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      harvest_project_id: 101,
      harvest_task_id: 202,
    });
    const t = createTask(db, { project_id: 'acme', title: 'Report' });
    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 90);
    seedConfirmed(db, t.id, 'acme', '2026-04-15T10:00:00Z', 60);

    const client = mockClient();
    const result = await harvestPushTimesheet(db, client, '2026-04-13', '2026-04-19');

    expect(result.pushed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(client.createTimeEntry).toHaveBeenCalledTimes(2);

    // Verify harvest_entry_id was stored
    const rows = db.prepare('SELECT harvest_entry_id FROM time_entry ORDER BY id').all() as any[];
    expect(rows[0].harvest_entry_id).toBe(1000);
    expect(rows[1].harvest_entry_id).toBe(1001);
  });

  it('skips entries already pushed (harvest_entry_id set)', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      harvest_project_id: 101,
      harvest_task_id: 202,
    });
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 60, {
      harvest_entry_id: 999,
    });

    const client = mockClient();
    const result = await harvestPushTimesheet(db, client, '2026-04-13', '2026-04-19');

    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(client.createTimeEntry).not.toHaveBeenCalled();
  });

  it('fails gracefully when project has no harvest mapping', async () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 60);

    const client = mockClient();
    const result = await harvestPushTimesheet(db, client, '2026-04-13', '2026-04-19');

    expect(result.pushed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('no harvest_project_id');
  });

  it('sends correct hours and notes to Harvest', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      harvest_project_id: 101,
      harvest_task_id: 202,
    });
    const t = createTask(db, { project_id: 'acme', title: 'Write docs' });
    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 75); // 1.25 hours

    const client = mockClient();
    await harvestPushTimesheet(db, client, '2026-04-13', '2026-04-19');

    expect(client.createTimeEntry).toHaveBeenCalledWith({
      project_id: 101,
      task_id: 202,
      spent_date: '2026-04-14',
      hours: 1.25,
      notes: 'Write docs',
    });
  });

  it('handles API errors without crashing the whole batch', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      harvest_project_id: 101,
      harvest_task_id: 202,
    });
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 60);
    seedConfirmed(db, t.id, 'acme', '2026-04-15T09:00:00Z', 60);

    const client = mockClient();
    let callCount = 0;
    (client.createTimeEntry as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('rate limited');
      return { id: 5000, project: { id: 1, name: 'P' }, task: { id: 1, name: 'T' }, spent_date: '', hours: 0, notes: null };
    });

    const result = await harvestPushTimesheet(db, client, '2026-04-13', '2026-04-19');

    expect(result.pushed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('rate limited');
  });

  it('refuses to push when UNCONFIRMED entries exist in range', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      harvest_project_id: 101,
      harvest_task_id: 202,
    });
    const t = createTask(db, { project_id: 'acme', title: 'Report' });
    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 60);
    seedUnconfirmed(db, t.id, 'acme', '2026-04-15T09:00:00Z', 60);

    const client = mockClient();
    await expect(
      harvestPushTimesheet(db, client, '2026-04-13', '2026-04-19'),
    ).rejects.toThrow(/unconfirmed/i);
    expect(client.createTimeEntry).not.toHaveBeenCalled();
  });

  it('proceeds when force: true is passed despite UNCONFIRMED entries', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      harvest_project_id: 101,
      harvest_task_id: 202,
    });
    const t = createTask(db, { project_id: 'acme', title: 'Report' });
    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 60);
    seedUnconfirmed(db, t.id, 'acme', '2026-04-15T09:00:00Z', 60);

    const client = mockClient();
    const result = await harvestPushTimesheet(
      db,
      client,
      '2026-04-13',
      '2026-04-19',
      { force: true },
    );
    // Only the CONFIRMED row pushes; the UNCONFIRMED row is filtered out.
    expect(result.pushed).toBe(1);
    expect(client.createTimeEntry).toHaveBeenCalledTimes(1);
  });

  it('respects the categories filter (default work excludes personal)', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      harvest_project_id: 101,
      harvest_task_id: 202,
      category_id: 'work',
    });
    createProject(db, {
      id: 'gym',
      name: 'Gym',
      prefix: 'GYM',
      harvest_project_id: 301,
      harvest_task_id: 302,
      category_id: 'personal',
    });
    const tw = createTask(db, { project_id: 'acme', title: 'Report' });
    const tp = createTask(db, { project_id: 'gym', title: 'Lift' });
    seedConfirmed(db, tw.id, 'acme', '2026-04-14T09:00:00Z', 60);
    seedConfirmed(db, tp.id, 'gym', '2026-04-14T18:00:00Z', 60);

    const client = mockClient();
    const result = await harvestPushTimesheet(db, client, '2026-04-13', '2026-04-19');
    expect(result.pushed).toBe(1);
    expect(client.createTimeEntry).toHaveBeenCalledTimes(1);
    expect(client.createTimeEntry).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 101 }),
    );
  });

  it('categories=["personal"] pushes only personal-category rows', async () => {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      harvest_project_id: 101,
      harvest_task_id: 202,
      category_id: 'work',
    });
    createProject(db, {
      id: 'gym',
      name: 'Gym',
      prefix: 'GYM',
      harvest_project_id: 301,
      harvest_task_id: 302,
      category_id: 'personal',
    });
    const tw = createTask(db, { project_id: 'acme', title: 'Report' });
    const tp = createTask(db, { project_id: 'gym', title: 'Lift' });
    seedConfirmed(db, tw.id, 'acme', '2026-04-14T09:00:00Z', 60);
    seedConfirmed(db, tp.id, 'gym', '2026-04-14T18:00:00Z', 60);

    const client = mockClient();
    const result = await harvestPushTimesheet(
      db,
      client,
      '2026-04-13',
      '2026-04-19',
      { categories: ['personal'] },
    );
    expect(result.pushed).toBe(1);
    expect(client.createTimeEntry).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 301 }),
    );
  });
});
