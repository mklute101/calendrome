/**
 * Week-in-the-hash helpers (#120). The GUI's router is the location
 * hash (`#/`, `#/budget`, `#/tasks`); the selected week rides along
 * as a query on that hash — `#/?week=2026-07-13` — so switching
 * between the timeline and budget views keeps the week. Week writes
 * go through history.replaceState, not `location.hash =`: no
 * hashchange event, so the mounted view isn't remounted and history
 * isn't spammed with one entry per arrow click.
 *
 * The pure parse/build pair below is window-free (unit-testable);
 * the two thin wrappers bind it to the real location.
 */

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `week` from a hash string, or null when absent/malformed. */
export function parseWeekFromHash(hash: string): string | null {
  const q = hash.indexOf('?');
  if (q === -1) return null;
  const week = new URLSearchParams(hash.slice(q + 1)).get('week');
  return week !== null && WEEK_RE.test(week) ? week : null;
}

/**
 * The hash with its `week` query set (or removed, for `null` — the
 * "Today" reset). Other query params survive; an empty hash counts
 * as the week route (`#/`).
 */
export function hashWithWeek(hash: string, week: string | null): string {
  const base = hash === '' ? '#/' : hash;
  const q = base.indexOf('?');
  const path = q === -1 ? base : base.slice(0, q);
  const params = new URLSearchParams(q === -1 ? '' : base.slice(q + 1));
  if (week === null) params.delete('week');
  else params.set('week', week);
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

// The wrappers reach location/history through globalThis with
// structural types: the unit tests import this module under the
// server tsconfig (no DOM lib), where `window`/`history` don't
// typecheck. Nothing is dereferenced until a browser calls them.
const browser = globalThis as unknown as {
  location: { hash: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
};

/** The current route's week, for a view's initial weekStart. */
export function routeWeek(): string | null {
  return parseWeekFromHash(browser.location.hash);
}

/** Write the week into the current hash; `null` clears it (Today). */
export function setRouteWeek(week: string | null): void {
  browser.history.replaceState(
    null,
    '',
    hashWithWeek(browser.location.hash, week),
  );
}

/** An `href` for cross-view nav links that carries the week along. */
export function weekHref(path: string, week: string): string {
  return hashWithWeek(path, week);
}
