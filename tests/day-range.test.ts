import { describe, it, expect } from 'vitest';
import { toUtcDay, toDayRange } from '../src/day-range.js';

describe('toUtcDay', () => {
  it('passes plain dates through untouched', () => {
    expect(toUtcDay('2026-07-06', 'from')).toBe('2026-07-06');
  });

  it('buckets a UTC timestamp to its date', () => {
    expect(toUtcDay('2026-07-06T00:00:00Z', 'from')).toBe('2026-07-06');
    expect(toUtcDay('2026-07-06T23:59:59.999Z', 'to')).toBe('2026-07-06');
  });

  it('converts offset timestamps to their UTC day, matching SQLite DATE()', () => {
    // 9am Chicago is 2pm UTC — same day.
    expect(toUtcDay('2026-07-06T09:00:00-05:00', 'from')).toBe('2026-07-06');
    // 8pm Chicago is 1am UTC the next day — SQLite's DATE() buckets the
    // stored value the same way, so the bound must agree.
    expect(toUtcDay('2026-07-06T20:00:00-05:00', 'from')).toBe('2026-07-07');
  });

  it('throws on garbage, naming the offending bound', () => {
    expect(() => toUtcDay('next tuesday', 'from')).toThrow(/from/);
    expect(() => toUtcDay('', 'to')).toThrow(/to/);
  });
});

describe('toDayRange', () => {
  it('normalizes mixed-format bounds', () => {
    expect(toDayRange('2026-07-06T00:00:00Z', '2026-07-12')).toEqual({
      fromDay: '2026-07-06',
      toDay: '2026-07-12',
    });
  });
});
