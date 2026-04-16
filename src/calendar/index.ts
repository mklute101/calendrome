export * from './types.js';
export { FakeCalendarClient } from './fake.js';
export { GoogleCalendarClient } from './google.js';

import { NotImplementedError, type CalendarClient } from './types.js';

/**
 * Default calendar client used when `buildTools()` is called without an
 * explicit `calendar` option. Throws on any call so missing wiring fails
 * loudly rather than silently dropping events.
 */
export const stubCalendar: CalendarClient = {
  async createEvent() {
    throw new NotImplementedError(
      'No CalendarClient configured. Pass `calendar: new FakeCalendarClient()` ' +
        '(tests) or `new GoogleCalendarClient()` (production) to buildTools().',
    );
  },
  async deleteEvent() {
    throw new NotImplementedError(
      'No CalendarClient configured. Pass `calendar: new FakeCalendarClient()` ' +
        '(tests) or `new GoogleCalendarClient()` (production) to buildTools().',
    );
  },
};
