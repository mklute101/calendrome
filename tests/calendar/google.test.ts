import { describe, it, expect } from 'vitest';
import { GoogleCalendarClient } from '../../src/calendar/google.js';
import { NotImplementedError } from '../../src/calendar/types.js';

describe('GoogleCalendarClient (Phase 2 stub)', () => {
  it('createEvent throws NotImplementedError', async () => {
    const client = new GoogleCalendarClient();
    await expect(
      client.createEvent({
        calendar_id: 'primary',
        summary: 'X',
        start: '2026-04-14T10:00:00Z',
        end: '2026-04-14T11:00:00Z',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('deleteEvent throws NotImplementedError', async () => {
    const client = new GoogleCalendarClient();
    await expect(
      client.deleteEvent({ calendar_id: 'primary', event_id: 'evt-1' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
