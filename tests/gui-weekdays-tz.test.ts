// Regression guard for #82: evening entries in a UTC- timezone must
// bucket to the LOCAL day, not the raw UTC date. This test only has
// teeth in a non-UTC zone, so it pins TZ before importing — the CI
// default (UTC) is exactly why the SPA rewrite regressed the fix
// silently (local date == UTC date, so the buggy slice looked correct).
process.env.TZ = 'America/Chicago';

import { describe, it, expect } from 'vitest';
import { buildDays } from '../src/gui/app/lib/weekdays';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    placements: [],
    tasks: [],
    habit_instances: [],
    time_logs: [],
    calendar_events: [],
    ...overrides,
  };
}

describe('buildDays local-day bucketing (#82 regression guard)', () => {
  it('sanity-checks the timezone is actually pinned', () => {
    // 00:00Z on the 14th is 19:00 on the 13th in America/Chicago.
    expect(new Date('2026-07-14T00:00:00Z').getDate()).toBe(13);
  });

  it('files a 7pm CT placement (stored 00:00Z next day) under local Monday, not Tuesday', () => {
    const data = payload({
      placements: [
        {
          time_entry_id: 1,
          task_id: 10,
          start_at: '2026-07-14T00:00:00Z', // 7:00pm CT Mon 7/13
          end_at: '2026-07-14T00:30:00Z',
          duration_minutes: 30,
          project_id: 'san',
          task_title: 'evening block',
        },
      ],
    });
    const days = buildDays(data as never, '2026-07-13');
    const mon = days.find((d) => d.date === '2026-07-13')!;
    const tue = days.find((d) => d.date === '2026-07-14')!;

    expect(mon.placed.map((p) => p.time_entry_id)).toContain(1);
    expect(tue.placed).toHaveLength(0);
  });

  it('keeps a daytime entry on its own day (no over-correction)', () => {
    const data = payload({
      placements: [
        {
          time_entry_id: 2,
          task_id: 11,
          start_at: '2026-07-15T14:00:00Z', // 9:00am CT Wed 7/15
          end_at: '2026-07-15T15:00:00Z',
          duration_minutes: 60,
          project_id: 'athletech',
          task_title: 'morning block',
        },
      ],
    });
    const days = buildDays(data as never, '2026-07-13');
    expect(days.find((d) => d.date === '2026-07-15')!.placed.map((p) => p.time_entry_id)).toContain(2);
  });
});
