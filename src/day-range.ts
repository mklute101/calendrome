/**
 * Shared day-bucket normalization for time_entry range reads.
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
