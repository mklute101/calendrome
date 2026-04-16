import {
  NotImplementedError,
  type CalendarClient,
  type CreateEventArgs,
  type DeleteEventArgs,
} from './types.js';

/**
 * Google Calendar adapter — Phase 2 implementation target.
 *
 * To complete this:
 *
 * 1. `npm i googleapis google-auth-library`
 * 2. One-time OAuth flow that stores a refresh token under `~/.calendrome/`
 *    (a small CLI script `bin/calendrome-auth.ts` is the easiest landing pad).
 *    Scopes needed: `https://www.googleapis.com/auth/calendar.events`.
 * 3. Replace the `NotImplementedError` bodies below with `googleapis` calls:
 *      const calendar = google.calendar({ version: 'v3', auth: this.oauth });
 *      const res = await calendar.events.insert({ calendarId, requestBody });
 *      return { id: res.data.id! };
 * 4. Add a `tests/calendar/google.test.ts` that exercises this against a
 *    dedicated test calendar (gated behind `RUN_GCAL_TESTS=1` so CI skips it).
 *
 * The adapter is intentionally a thin shim — the MCP tool layer already
 * does all the project/calendar/event-id bookkeeping. This class just needs
 * to talk to Google.
 */
export interface GoogleCalendarClientOptions {
  /** Path to the stored OAuth token. Default: `~/.calendrome/token.json`. */
  tokenPath?: string;
  /** Path to the OAuth client secrets. Default: `~/.calendrome/credentials.json`. */
  credentialsPath?: string;
}

export class GoogleCalendarClient implements CalendarClient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly options: GoogleCalendarClientOptions = {}) {}

  async createEvent(_args: CreateEventArgs): Promise<{ id: string }> {
    throw new NotImplementedError(
      'GoogleCalendarClient.createEvent is a Phase 2 stub. ' +
        'Use FakeCalendarClient for tests, or implement Google OAuth + googleapis.',
    );
  }

  async deleteEvent(_args: DeleteEventArgs): Promise<void> {
    throw new NotImplementedError(
      'GoogleCalendarClient.deleteEvent is a Phase 2 stub. ' +
        'Use FakeCalendarClient for tests, or implement Google OAuth + googleapis.',
    );
  }
}
