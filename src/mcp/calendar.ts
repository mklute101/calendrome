/**
 * Google Calendar adapter interface.
 *
 * Phase 1 uses a stub that throws on any call — tests pass an in-memory
 * fake. Phase 2 will implement the real adapter via `googleapis`.
 */
export interface CalendarClient {
  createEvent(args: {
    calendar_id: string | null;
    summary: string;
    start: string;
    end: string;
    description?: string;
  }): Promise<{ id: string }>;

  deleteEvent(args: {
    calendar_id: string | null;
    event_id: string;
  }): Promise<void>;
}

export const stubCalendar: CalendarClient = {
  async createEvent() {
    throw new Error(
      'Google Calendar not configured (Phase 2). Pass a calendar adapter to buildTools().',
    );
  },
  async deleteEvent() {
    throw new Error(
      'Google Calendar not configured (Phase 2). Pass a calendar adapter to buildTools().',
    );
  },
};
