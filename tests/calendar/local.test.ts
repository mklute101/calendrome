import { describe, it, expect } from 'vitest';
import { LocalCalendarClient } from '../../src/calendar/local.js';

describe('LocalCalendarClient', () => {
  it('createEvent returns a unique local- prefixed id', async () => {
    const cal = new LocalCalendarClient();
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
    expect(a.id).toMatch(/^local-[0-9a-f-]{36}$/);
    expect(b.id).toMatch(/^local-[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
  });

  it('createEvent ids do not collide across fresh client instances', async () => {
    // Regression guard for FakeCalendarClient's sequential `evt-N` ids:
    // a fresh process must not regenerate the same id as a previous one.
    const first = new LocalCalendarClient();
    const second = new LocalCalendarClient();
    const a = await first.createEvent({
      calendar_id: null,
      summary: 'X',
      start: '2026-04-14T10:00:00Z',
      end: '2026-04-14T10:30:00Z',
    });
    const b = await second.createEvent({
      calendar_id: null,
      summary: 'X',
      start: '2026-04-14T10:00:00Z',
      end: '2026-04-14T10:30:00Z',
    });
    expect(a.id).not.toBe(b.id);
  });

  it('deleteEvent is a no-op and never throws', async () => {
    const cal = new LocalCalendarClient();
    await expect(
      cal.deleteEvent({ calendar_id: 'cal-1', event_id: 'local-anything' }),
    ).resolves.toBeUndefined();
    await expect(
      cal.deleteEvent({ calendar_id: null, event_id: 'never-created' }),
    ).resolves.toBeUndefined();
  });
});
