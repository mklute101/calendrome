import { describe, it, expect } from 'vitest';
import { FakeCalendarClient } from '../../src/calendar/fake.js';

describe('FakeCalendarClient', () => {
  it('createEvent stores the event and returns deterministic ids', async () => {
    const cal = new FakeCalendarClient();
    const a = await cal.createEvent({
      calendar_id: 'cal-1',
      summary: 'A',
      start: '2026-04-14T10:00:00Z',
      end: '2026-04-14T11:00:00Z',
    });
    const b = await cal.createEvent({
      calendar_id: 'cal-1',
      summary: 'B',
      start: '2026-04-14T11:00:00Z',
      end: '2026-04-14T12:00:00Z',
    });
    expect(a.id).toBe('evt-1');
    expect(b.id).toBe('evt-2');
    expect(cal.events).toHaveLength(2);
    expect(cal.events[0].summary).toBe('A');
  });

  it('records optional description', async () => {
    const cal = new FakeCalendarClient();
    await cal.createEvent({
      calendar_id: null,
      summary: 'X',
      start: '2026-04-14T10:00:00Z',
      end: '2026-04-14T10:30:00Z',
      description: 'notes here',
    });
    expect(cal.events[0].description).toBe('notes here');
  });

  it('deleteEvent removes the matching event', async () => {
    const cal = new FakeCalendarClient();
    const { id } = await cal.createEvent({
      calendar_id: 'cal-1',
      summary: 'X',
      start: '2026-04-14T10:00:00Z',
      end: '2026-04-14T10:30:00Z',
    });
    await cal.deleteEvent({ calendar_id: 'cal-1', event_id: id });
    expect(cal.events).toHaveLength(0);
    expect(cal.getEvent(id)).toBeUndefined();
  });

  it('deleteEvent throws when the event is missing', async () => {
    const cal = new FakeCalendarClient();
    await expect(
      cal.deleteEvent({ calendar_id: 'cal-1', event_id: 'evt-nope' }),
    ).rejects.toThrow(/not found/);
  });

  it('listEvents filters by calendar_id', async () => {
    const cal = new FakeCalendarClient();
    await cal.createEvent({
      calendar_id: 'a',
      summary: '1',
      start: '2026-04-14T10:00:00Z',
      end: '2026-04-14T10:30:00Z',
    });
    await cal.createEvent({
      calendar_id: 'b',
      summary: '2',
      start: '2026-04-14T10:00:00Z',
      end: '2026-04-14T10:30:00Z',
    });
    await cal.createEvent({
      calendar_id: 'a',
      summary: '3',
      start: '2026-04-14T10:00:00Z',
      end: '2026-04-14T10:30:00Z',
    });
    expect(cal.listEvents('a')).toHaveLength(2);
    expect(cal.listEvents('b')).toHaveLength(1);
    expect(cal.listEvents()).toHaveLength(3);
  });

  it('reset clears events and resets id counter', async () => {
    const cal = new FakeCalendarClient();
    await cal.createEvent({
      calendar_id: null,
      summary: 'X',
      start: '2026-04-14T10:00:00Z',
      end: '2026-04-14T10:30:00Z',
    });
    cal.reset();
    const fresh = await cal.createEvent({
      calendar_id: null,
      summary: 'Y',
      start: '2026-04-14T11:00:00Z',
      end: '2026-04-14T11:30:00Z',
    });
    expect(cal.events).toHaveLength(1);
    expect(fresh.id).toBe('evt-1');
  });
});
