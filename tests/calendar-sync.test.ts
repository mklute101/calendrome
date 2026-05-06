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
