/**
 * The one wall clock (#149).
 *
 * Every bookkeeping timestamp the server writes (`created_at`,
 * `updated_at`, `confirmed_at`, `synced_at`, `completed_at`) and every
 * "what time is it" read (pending-review default range, future-entry
 * guard, current-week Monday) funnels through here instead of SQLite's
 * `datetime('now')` or a bare `new Date()`. That makes simulated time
 * a single env var — a demo replay, a screenshotted walkthrough, or a
 * time-dependent test sets `CALENDROME_NOW` and gets honest timestamps
 * end to end, instead of post-hoc rewriting stamps across 17
 * table/column pairs.
 *
 * `CALENDROME_NOW` accepts:
 * - a fixed ISO 8601 timestamp (`2026-07-31T17:00:00Z`) — the clock
 *   freezes there;
 * - a relative offset (`-3d`, `+2h`, `-90m`) — the clock keeps
 *   ticking, shifted from real time.
 *
 * Unset (the normal case) means real time. The GUI SPA runs in the
 * browser and keeps its own clock — threading a payload `now` into it
 * is the demo-clock item on the playground roadmap (#110).
 */

const OFFSET = /^([+-])(\d+)([mhd])$/;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function nowMs(): number {
  const override = process.env.CALENDROME_NOW;
  if (!override) return Date.now();
  const offset = OFFSET.exec(override);
  if (offset) {
    const delta = Number(offset[2]) * UNIT_MS[offset[3]];
    return Date.now() + (offset[1] === '-' ? -delta : delta);
  }
  const ms = Date.parse(override);
  if (Number.isNaN(ms)) {
    throw new Error(
      `CALENDROME_NOW must be an ISO 8601 timestamp or a relative offset like -3d/+2h/-90m, got: ${override}`,
    );
  }
  return ms;
}

export function nowDate(): Date {
  return new Date(nowMs());
}

/**
 * The current moment in the canonical stored form
 * (`YYYY-MM-DDTHH:MM:SSZ`, see `day-range.ts`). This is what write
 * paths bind for bookkeeping columns — one format, unlike the
 * historical mix of `datetime('now')` (space-form) and
 * `strftime('…T…Z', 'now')` output.
 */
export function now(): string {
  return new Date(nowMs()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
