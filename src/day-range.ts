/**
 * Shared timestamp normalization for time_entry: canonical storage
 * form on the write side, day-bucket semantics on the read side.
 *
 * Every read path that filters `time_entry` by date range must resolve
 * the same rows for the same `from`/`to` — regardless of whether the
 * caller passed a plain date (`2026-07-06`) or a full ISO timestamp
 * (`2026-07-06T00:00:00Z`). Before this helper existed, each query
 * hand-rolled its own bounds and they diverged: comparing
 * `DATE(te.start_at)` (a bare `YYYY-MM-DD`) against a timestamp string
 * silently dropped the entire first day of the range, because
 * `'2026-07-06' >= '2026-07-06T00:00:00Z'` is false in SQLite's
 * lexicographic string ordering (#92).
 *
 * Canonical semantics: a range is a pair of inclusive UTC day buckets.
 * Timestamps are collapsed to the UTC date they fall on — matching how
 * SQLite's `DATE()` buckets stored `start_at` values (offset-stamped
 * times are converted to UTC first). Queries compare
 * `DATE(te.start_at)` against these plain-date bounds.
 */

import { nowDate } from './clock.js';

/**
 * Canonical stored timestamp form: UTC, second precision, `Z` suffix
 * (`YYYY-MM-DDTHH:MM:SSZ`). Every `time_entry` write path funnels its
 * timestamps through `toCanonicalUtc` so rows never persist mixed
 * offsets (`…T11:15:00-05:00`) or mixed precision (`…T19:15:00.000Z`)
 * — both of which make `DATE(start_at)` bucketing and raw string
 * comparisons hazardous (#95).
 */
export const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Normalize an ISO 8601 timestamp to the canonical stored form.
 * Offset-stamped inputs are converted to UTC; fractional seconds are
 * dropped. Throws on anything unparseable.
 */
export function toCanonicalUtc(value: string, label: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${label} is not a valid ISO 8601 timestamp: ${value}`);
  }
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface DayRange {
  /** Inclusive first day, YYYY-MM-DD. */
  fromDay: string;
  /** Inclusive last day, YYYY-MM-DD. */
  toDay: string;
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Collapse a plain date or ISO 8601 timestamp to its UTC day
 * (`YYYY-MM-DD`). Throws on anything else.
 */
export function toUtcDay(value: string, label: string): string {
  if (PLAIN_DATE.test(value)) return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(
      `${label} must be a plain date (YYYY-MM-DD) or an ISO 8601 timestamp, got: ${value}`,
    );
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Normalize caller-supplied range bounds to inclusive UTC day buckets.
 */
export function toDayRange(from: string, to: string): DayRange {
  return {
    fromDay: toUtcDay(from, 'from'),
    toDay: toUtcDay(to, 'to'),
  };
}

// ---------------------------------------------------------------------------
// Week boundaries for weekly accounting (#146).
//
// Range *reads* above are inclusive UTC day buckets. Weekly *rollups*
// (budgets, goals, envelopes, supply) are user-facing pacing, so their
// week follows the envelope's category timezone: `[Mon 00:00, next
// Mon 00:00)` in local wall-clock time, resolved to UTC instants. A
// 'UTC' timezone reproduces the former `T00:00:00Z` arithmetic exactly.
// ---------------------------------------------------------------------------

/**
 * Throw unless `timeZone` is an IANA name the runtime knows. Every
 * rollup resolves week bounds through `Intl`, which raises a bare
 * RangeError on a typo ('America/Chicgo'); the write side rejects it
 * with a clear message instead, so a bad value never reaches the DB.
 */
export function assertValidTimezone(timeZone: string, label = 'timezone'): void {
  if (typeof timeZone !== 'string' || timeZone === '') {
    throw new Error(`${label} must be an IANA timezone name, got: ${String(timeZone)}`);
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
  } catch {
    throw new Error(`${label} is not a valid IANA timezone: ${timeZone}`);
  }
}

// Intl.DateTimeFormat construction is the expensive part of every
// offset lookup; one formatter per zone (per shape) is reused.
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = offsetFormatters.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    offsetFormatters.set(timeZone, dtf);
  }
  return dtf;
}

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = dayFormatters.get(timeZone);
  if (!dtf) {
    // en-CA formats as YYYY-MM-DD directly.
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timeZone, dtf);
  }
  return dtf;
}

/** Offset (ms to add to UTC to get wall-clock time) of `timeZone` at `utcMs`. */
export function tzOffsetMs(timeZone: string, utcMs: number): number {
  const parts = offsetFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - utcMs;
}

/**
 * UTC instant (epoch ms) of local `day` (YYYY-MM-DD) + `hhmm` in
 * `timeZone`. Two offset iterations handle DST-boundary days.
 */
export function zonedTimeToUtcMs(day: string, hhmm: string, timeZone: string): number {
  const naive = Date.parse(`${day}T${hhmm}:00Z`);
  if (Number.isNaN(naive)) {
    throw new Error(`invalid local time: ${day} ${hhmm}`);
  }
  if (timeZone === 'UTC') return naive;
  let offset = tzOffsetMs(timeZone, naive);
  offset = tzOffsetMs(timeZone, naive - offset);
  return naive - offset;
}

/** Plain-date arithmetic: `day` + n calendar days (YYYY-MM-DD). */
export function addDays(day: string, n: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`invalid date: ${day}`);
  return new Date(ms + n * 86_400_000).toISOString().slice(0, 10);
}

/** Calendar date (YYYY-MM-DD) that a UTC instant falls on in `timeZone`. */
export function localDayOf(instant: Date, timeZone: string): string {
  if (timeZone === 'UTC') return instant.toISOString().slice(0, 10);
  return dayFormatter(timeZone).format(instant);
}

/** Monday of the ISO week containing the plain date `day`. */
export function mondayOfDay(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  if (Number.isNaN(dow)) throw new Error(`invalid date: ${day}`);
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}

export interface WeekRange {
  /** Canonical UTC instant of local Monday 00:00 (inclusive). */
  startIso: string;
  /** Canonical UTC instant of the following local Monday 00:00 (exclusive). */
  endIso: string;
}

/**
 * UTC bounds of the week starting on local Monday `weekStart` in
 * `timezone`: `[Mon 00:00, next Mon 00:00)` wall-clock, as canonical
 * UTC strings (`YYYY-MM-DDTHH:MM:SSZ`). DST-safe: a week spanning a
 * change is 167h or 169h long, never forced to 168h. Queries compare
 * `start_at >= startIso AND start_at < endIso`.
 */
export function weekRange(weekStart: string, timezone = 'UTC'): WeekRange {
  if (!PLAIN_DATE.test(weekStart) || Number.isNaN(Date.parse(`${weekStart}T00:00:00Z`))) {
    throw new Error(`invalid week_start: ${weekStart}`);
  }
  const startMs = zonedTimeToUtcMs(weekStart, '00:00', timezone);
  const endMs = zonedTimeToUtcMs(addDays(weekStart, 7), '00:00', timezone);
  return {
    startIso: toCanonicalUtc(new Date(startMs).toISOString(), 'week start'),
    endIso: toCanonicalUtc(new Date(endMs).toISOString(), 'week end'),
  };
}

/**
 * Monday (YYYY-MM-DD) of the week containing `now` in `timezone`.
 * Defaults to the clock's now and UTC — the week an instant belongs
 * to only has one answer per timezone, so callers rolling up an
 * envelope pass its category's timezone.
 */
export function currentWeekMonday(now: Date = nowDate(), timezone = 'UTC'): string {
  return mondayOfDay(localDayOf(now, timezone));
}
