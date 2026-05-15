import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import {
  syncCalendarEvents,
  deleteCalendarEventsInRange,
  listCalendarEvents,
} from '../src/calendar-sync.js';

describe('calendar-sync', () => {
  it('syncCalendarEvents upserts events and computes duration', () => {
    const db = freshDb();
    const result = syncCalendarEvents(db, [
      {
        id: 'evt-1',
        calendar_id: 'cal-work',
        summary: 'Standup',
        start: '2026-05-05T10:00:00Z',
        end: '2026-05-05T10:30:00Z',
        is_meeting: true,
      },
      {
        id: 'evt-2',
        calendar_id: 'cal-work',
        summary: 'Deep Work',
        start: '2026-05-05T14:00:00Z',
        end: '2026-05-05T16:00:00Z',
        is_meeting: false,
      },
    ]);

    expect(result.upserted).toBe(2);
    expect(result.deleted).toBe(0);

    const events = listCalendarEvents(db, '2026-05-05T00:00:00', '2026-05-05T23:59:59');
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('evt-1');
    expect(events[0].duration_minutes).toBe(30);
    expect(events[0].is_meeting).toBe(1);
    expect(events[1].id).toBe('evt-2');
    expect(events[1].duration_minutes).toBe(120);
    expect(events[1].is_meeting).toBe(0);
  });

  it('syncCalendarEvents with clear_range deletes old events first', () => {
    const db = freshDb();

    // Seed an existing event
    syncCalendarEvents(db, [
      {
        id: 'old-evt',
        calendar_id: 'cal-work',
        summary: 'Old Meeting',
        start: '2026-05-05T09:00:00Z',
        end: '2026-05-05T09:30:00Z',
        is_meeting: true,
      },
    ]);

    // Clear and re-sync
    const deleted = deleteCalendarEventsInRange(
      db,
      '2026-05-05T00:00:00Z',
      '2026-05-05T23:59:59Z',
    );
    expect(deleted).toBe(1);

    const result = syncCalendarEvents(db, [
      {
        id: 'new-evt',
        calendar_id: 'cal-work',
        summary: 'New Meeting',
        start: '2026-05-05T10:00:00Z',
        end: '2026-05-05T11:00:00Z',
        is_meeting: true,
      },
    ]);
    expect(result.upserted).toBe(1);

    const events = listCalendarEvents(db, '2026-05-05T00:00:00', '2026-05-05T23:59:59');
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('new-evt');
  });

  it('listCalendarEvents returns events in date range', () => {
    const db = freshDb();
    syncCalendarEvents(db, [
      {
        id: 'mon',
        calendar_id: 'cal-a',
        summary: 'Monday',
        start: '2026-05-04T10:00:00Z',
        end: '2026-05-04T11:00:00Z',
      },
      {
        id: 'tue',
        calendar_id: 'cal-a',
        summary: 'Tuesday',
        start: '2026-05-05T10:00:00Z',
        end: '2026-05-05T11:00:00Z',
      },
      {
        id: 'wed',
        calendar_id: 'cal-a',
        summary: 'Wednesday',
        start: '2026-05-06T10:00:00Z',
        end: '2026-05-06T11:00:00Z',
      },
    ]);

    // Only query Tuesday
    const events = listCalendarEvents(db, '2026-05-05T00:00:00Z', '2026-05-05T23:59:59Z');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Tuesday');
  });

  it('upserts into time_entry with source=gcal-sync and external_id=event.id', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix, calendar_id) VALUES ('A', 'A', 'A', 'cal-a')`).run();
    syncCalendarEvents(db, [
      { id: 'evt-1', calendar_id: 'cal-a', project_id: 'A', summary: 'Standup', start: '2026-05-13T09:00:00Z', end: '2026-05-13T09:30:00Z', is_meeting: true },
    ]);
    const row = db.prepare(`SELECT status, source, external_id, project_id, is_meeting FROM time_entry WHERE external_id = 'evt-1'`).get() as any;
    expect(row.status).toBe('UNCONFIRMED');
    expect(row.source).toBe('gcal-sync');
    expect(row.project_id).toBe('A');
    expect(row.is_meeting).toBe(1);
  });

  it('preserves CONFIRMED status and actual_minutes when re-syncing the same event', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix, calendar_id) VALUES ('A', 'A', 'A', 'cal-a')`).run();
    syncCalendarEvents(db, [
      { id: 'evt-1', calendar_id: 'cal-a', project_id: 'A', summary: 'Standup', start: '2026-05-13T09:00:00Z', end: '2026-05-13T09:30:00Z', is_meeting: true },
    ]);
    // user confirms
    db.prepare(`UPDATE time_entry SET status='CONFIRMED', confirmed_at=datetime('now'), actual_minutes=25 WHERE external_id='evt-1'`).run();
    // re-sync same event
    syncCalendarEvents(db, [
      { id: 'evt-1', calendar_id: 'cal-a', project_id: 'A', summary: 'Standup', start: '2026-05-13T09:00:00Z', end: '2026-05-13T09:30:00Z', is_meeting: true },
    ]);
    const row = db.prepare(`SELECT status, actual_minutes FROM time_entry WHERE external_id='evt-1'`).get() as any;
    expect(row.status).toBe('CONFIRMED');
    expect(row.actual_minutes).toBe(25);
  });

  it('updates sync fields (start/end/is_meeting/notes) on re-sync without un-confirming', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix, calendar_id) VALUES ('A', 'A', 'A', 'cal-a')`).run();
    syncCalendarEvents(db, [
      { id: 'evt-1', calendar_id: 'cal-a', project_id: 'A', summary: 'Standup', start: '2026-05-13T09:00:00Z', end: '2026-05-13T09:30:00Z', is_meeting: true },
    ]);
    db.prepare(`UPDATE time_entry SET status='CONFIRMED', confirmed_at=datetime('now'), actual_minutes=25 WHERE external_id='evt-1'`).run();
    // user reschedules in gcal; re-sync sees new times
    syncCalendarEvents(db, [
      { id: 'evt-1', calendar_id: 'cal-a', project_id: 'A', summary: 'Standup (moved)', start: '2026-05-13T10:00:00Z', end: '2026-05-13T10:30:00Z', is_meeting: true },
    ]);
    const row = db.prepare(`SELECT status, start_at, end_at, notes FROM time_entry WHERE external_id='evt-1'`).get() as any;
    expect(row.status).toBe('CONFIRMED');         // unchanged
    expect(row.start_at).toBe('2026-05-13T10:00:00Z');  // updated
    expect(row.end_at).toBe('2026-05-13T10:30:00Z');    // updated
    expect(row.notes).toBe('Standup (moved)');     // updated
  });

  it('deleteCalendarEventsInRange removes UNCONFIRMED gcal-sync time_entry rows but preserves CONFIRMED ones', () => {
    const db = freshDb();
    syncCalendarEvents(db, [
      { id: 'evt-unc', calendar_id: 'c', summary: 'A', start: '2026-05-13T09:00:00Z', end: '2026-05-13T10:00:00Z' },
      { id: 'evt-conf', calendar_id: 'c', summary: 'B', start: '2026-05-13T11:00:00Z', end: '2026-05-13T12:00:00Z' },
    ]);
    db.prepare(`UPDATE time_entry SET status='CONFIRMED', confirmed_at=datetime('now') WHERE external_id='evt-conf'`).run();

    deleteCalendarEventsInRange(db, '2026-05-13T00:00:00Z', '2026-05-13T23:59:59Z');

    const survivors = db.prepare(`SELECT external_id, status FROM time_entry WHERE source='gcal-sync'`).all();
    expect(survivors).toEqual([{ external_id: 'evt-conf', status: 'CONFIRMED' }]);
  });

  it('duplicate IDs are updated (not duplicated)', () => {
    const db = freshDb();

    syncCalendarEvents(db, [
      {
        id: 'evt-dup',
        calendar_id: 'cal-work',
        summary: 'Original Title',
        start: '2026-05-05T10:00:00Z',
        end: '2026-05-05T11:00:00Z',
        is_meeting: false,
      },
    ]);

    // Upsert same ID with new title
    syncCalendarEvents(db, [
      {
        id: 'evt-dup',
        calendar_id: 'cal-work',
        summary: 'Updated Title',
        start: '2026-05-05T10:00:00Z',
        end: '2026-05-05T11:30:00Z',
        is_meeting: true,
      },
    ]);

    const events = listCalendarEvents(db, '2026-05-05T00:00:00', '2026-05-05T23:59:59');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Updated Title');
    expect(events[0].duration_minutes).toBe(90);
    expect(events[0].is_meeting).toBe(1);
  });
});
