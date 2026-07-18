import { describe, it, expect } from 'vitest';
import { hashWithWeek, parseWeekFromHash } from '../src/gui/app/lib/route.js';

/**
 * Week-in-the-hash helpers (#120): the selected week rides the hash
 * route (`#/?week=YYYY-MM-DD`) so it survives the trip between the
 * timeline and budget views. These are the pure parse/build halves;
 * the window bindings (routeWeek/setRouteWeek) are one-liners over
 * them and are exercised by manual verification.
 */
describe('parseWeekFromHash', () => {
  it('reads the week query off any route', () => {
    expect(parseWeekFromHash('#/?week=2026-07-13')).toBe('2026-07-13');
    expect(parseWeekFromHash('#/budget?week=2026-07-20')).toBe('2026-07-20');
  });

  it('returns null when absent or malformed', () => {
    expect(parseWeekFromHash('')).toBeNull();
    expect(parseWeekFromHash('#/')).toBeNull();
    expect(parseWeekFromHash('#/budget')).toBeNull();
    expect(parseWeekFromHash('#/?other=x')).toBeNull();
    expect(parseWeekFromHash('#/?week=next-week')).toBeNull();
    expect(parseWeekFromHash('#/?week=2026-7-13')).toBeNull();
  });
});

describe('hashWithWeek', () => {
  it('sets, replaces, and clears the week on a route', () => {
    expect(hashWithWeek('#/', '2026-07-13')).toBe('#/?week=2026-07-13');
    expect(hashWithWeek('#/budget', '2026-07-13')).toBe('#/budget?week=2026-07-13');
    expect(hashWithWeek('#/?week=2026-07-13', '2026-07-20')).toBe(
      '#/?week=2026-07-20',
    );
    // null clears it — the "Today" reset.
    expect(hashWithWeek('#/budget?week=2026-07-13', null)).toBe('#/budget');
    expect(hashWithWeek('#/', null)).toBe('#/');
  });

  it('treats an empty hash as the week route and keeps other params', () => {
    expect(hashWithWeek('', '2026-07-13')).toBe('#/?week=2026-07-13');
    expect(hashWithWeek('#/?other=x', '2026-07-13')).toBe(
      '#/?other=x&week=2026-07-13',
    );
    expect(hashWithWeek('#/?other=x&week=2026-07-13', null)).toBe('#/?other=x');
  });

  it('round-trips with the parser', () => {
    expect(parseWeekFromHash(hashWithWeek('#/budget', '2026-07-13'))).toBe(
      '2026-07-13',
    );
    expect(parseWeekFromHash(hashWithWeek('#/?week=2026-07-13', null))).toBeNull();
  });
});
