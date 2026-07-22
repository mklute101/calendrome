/**
 * Week supply computation (#106, M4) — the "income" side of envelope
 * budgeting for time.
 *
 * The week has a computable hour supply: category scheduling windows
 * (`categories.default_window` — work Mon–Fri 9–5, personal evenings/
 * weekends, seeded in `src/db/migrate.ts`) minus synced calendar
 * events (`time_entry` rows with `source='gcal-sync'`) minus
 * `block_time` reservations (`availability_overrides.available = 0`)
 * plus `open_time` carve-outs (`available = 1`) plus scheduled time
 * sitting outside all of the above (see below). Supply is *swaths,
 * not blocks* — open time exists without being scheduled — and it is
 * per-category but fungible: category splits shape where the planner
 * *suggests* hours land, never walls between pools.
 *
 * Windows are guidelines, not rules: nothing gates placing an entry
 * outside its category's window, and the act of scheduling there IS
 * the override — no `open_time` ceremony required. Out-of-window
 * scheduled time (non-gcal entries beyond window + opens) self-
 * supplies as `scheduled_outside_minutes`, so an evening work
 * placement adds the hours it actually claims instead of making the
 * week read falsely overcommitted.
 *
 * To-Be-Assigned = total supply − assigned (the sum of effective
 * envelope assignments from `getEnvelopes`). Negative means the week
 * is overcommitted — YNAB's "you assigned more than you have".
 *
 * Edge decisions (v1), each enforced below:
 *  - Overlapping events are merged before subtracting — a double-
 *    booked hour costs the supply one hour, not two.
 *  - A block over an event doesn't double-subtract: blocked minutes
 *    are counted only where the window is not already event-occupied.
 *  - `open_time` inside a window adds nothing (the window already
 *    counts it); opened swaths are also carved by events and blocks,
 *    and block wins over open ("actually I'm free again" is
 *    `clear_availability`, not a competing open).
 *  - Global (category_id NULL) blocks apply to every category's
 *    window. Global opens are attributed to the first category by
 *    display order so the total never double-counts them — supply is
 *    fungible, so the attribution only affects the per-category
 *    split, not the bottom line.
 *  - Windows spanning midnight (end <= start) are unsupported in v1
 *    and contribute nothing.
 *  - Window times are interpreted in the category's timezone; the
 *    week's days are its 7 civil dates (Monday..Sunday). Overrides
 *    and events are UTC instants (see src/day-range.ts).
 *  - Categories with overlapping windows would each count the shared
 *    wall-clock time (windows are eligibility, not exclusive
 *    ownership); the seeded work/personal windows don't overlap.
 *  - Out-of-window scheduled time self-supplies only where the time
 *    is genuinely unclaimed: overlapping entries merge first, and
 *    minutes already covered by the window, an open, a synced event,
 *    or an explicit block mint nothing. A block is explicit user
 *    intent ("not then"), so placing over one is allowed but does
 *    not add supply. Entries without a project fall back to the
 *    'work' category (the GUI's convention); like overlapping
 *    windows, cross-category placements only shape the per-category
 *    split — supply stays fungible.
 */
import type { DB } from './db/connection.js';
import { getEnvelopes } from './assignments.js';
import { listAvailabilityOverrides } from './availability.js';
import { listCategories, type CategoryWindow } from './categories.js';
import { assertMonday } from './goals.js';

export interface CategorySupply {
  category_id: string;
  /** Minutes the category's default window spans this week. */
  window_minutes: number;
  /** Window minutes occupied by synced (gcal-sync) events. */
  event_minutes: number;
  /** Window minutes reserved via block_time (not already event-occupied). */
  blocked_minutes: number;
  /** Extra minutes carved out via open_time outside the window. */
  opened_minutes: number;
  /**
   * Scheduled (non-gcal) entry minutes outside window + opens — the
   * implicit override: placing there is what claims the hours.
   */
  scheduled_outside_minutes: number;
  /** window − events − blocked + opened + scheduled_outside. */
  supply_minutes: number;
}

export interface WeekSupply {
  week_start: string;
  by_category: CategorySupply[];
  total_supply_minutes: number;
  /** Sum of effective envelope assignments (getEnvelopes; snoozed = 0). */
  assigned_minutes: number;
  /** total supply − assigned; negative = overcommitted. */
  to_be_assigned_minutes: number;
}

// ---------------------------------------------------------------------------
// Interval math — half-open [start, end) epoch-ms intervals.
// ---------------------------------------------------------------------------

interface Interval {
  start: number; // epoch ms, inclusive
  end: number; // epoch ms, exclusive
}

/** Sort + coalesce overlapping/adjacent intervals; drops empty ones. */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((iv) => iv.end > iv.start)
    .slice()
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

/** Intersection of two merged interval lists. */
function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push({ start, end });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

/** base − cuts, both merged interval lists. */
function subtractIntervals(base: Interval[], cuts: Interval[]): Interval[] {
  const out: Interval[] = [];
  let j = 0;
  for (const iv of base) {
    let cursor = iv.start;
    // Skip cuts that end before this base interval.
    while (j < cuts.length && cuts[j].end <= iv.start) j++;
    let k = j;
    while (k < cuts.length && cuts[k].start < iv.end) {
      if (cuts[k].start > cursor) {
        out.push({ start: cursor, end: cuts[k].start });
      }
      cursor = Math.max(cursor, cuts[k].end);
      if (cursor >= iv.end) break;
      k++;
    }
    if (cursor < iv.end) out.push({ start: cursor, end: iv.end });
  }
  return out;
}

function totalMinutes(intervals: Interval[]): number {
  const ms = intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  return Math.round(ms / 60_000);
}

// ---------------------------------------------------------------------------
// Timezone-aware window expansion.
// ---------------------------------------------------------------------------

/** Offset (ms to add to UTC to get wall-clock time) of `timeZone` at `utcMs`. */
function tzOffsetMs(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
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
 * UTC instant of local `day` (YYYY-MM-DD) + `hhmm` in `timeZone`.
 * Two offset iterations handle DST-boundary days.
 */
function zonedTimeToUtcMs(day: string, hhmm: string, timeZone: string): number {
  const naive = Date.parse(`${day}T${hhmm}:00Z`);
  if (Number.isNaN(naive)) {
    throw new Error(`invalid window time: ${day} ${hhmm}`);
  }
  if (timeZone === 'UTC') return naive;
  let offset = tzOffsetMs(timeZone, naive);
  offset = tzOffsetMs(timeZone, naive - offset);
  return naive - offset;
}

/** `weekStart` + n days, as a plain ISO date. */
function addDays(weekStart: string, n: number): string {
  return new Date(Date.parse(`${weekStart}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Expand a category window over the week's 7 civil dates into merged
 * UTC intervals. `days` uses 0=Sun..6=Sat (the CategoryWindow shape);
 * windows with end <= start (overnight) are unsupported and skipped.
 */
function windowIntervals(
  weekStart: string,
  window: CategoryWindow | null,
  timeZone: string,
): Interval[] {
  if (!window || window.end <= window.start) return [];
  const out: Interval[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (!window.days.includes(dow)) continue;
    out.push({
      start: zonedTimeToUtcMs(day, window.start, timeZone),
      end: zonedTimeToUtcMs(day, window.end, timeZone),
    });
  }
  return mergeIntervals(out);
}

// ---------------------------------------------------------------------------
// The computation.
// ---------------------------------------------------------------------------

/**
 * Compute the week's hour supply for the Monday-anchored week
 * `weekStart` (rejects non-Mondays). See the module header for the
 * formula and every edge decision.
 */
export function computeWeekSupply(db: DB, weekStart: string): WeekSupply {
  assertMonday(weekStart);
  const weekStartMs = Date.parse(`${weekStart}T00:00:00Z`);
  const weekEndMs = weekStartMs + 7 * 86_400_000;
  const weekStartIso = new Date(weekStartMs).toISOString().replace('.000Z', 'Z');
  const weekEndIso = new Date(weekEndMs).toISOString().replace('.000Z', 'Z');
  const week: Interval[] = [{ start: weekStartMs, end: weekEndMs }];

  // Synced events overlapping the week, merged so a double-booked hour
  // subtracts once. Both UNCONFIRMED and CONFIRMED occupy time.
  // Timestamps are canonical UTC (src/day-range.ts), so the string
  // range filter and Date.parse agree.
  const eventRows = db
    .prepare(
      `SELECT start_at, end_at FROM time_entry
        WHERE source = 'gcal-sync' AND start_at < ? AND end_at > ?`,
    )
    .all(weekEndIso, weekStartIso) as { start_at: string; end_at: string }[];
  const events = mergeIntervals(
    eventRows.map((r) => ({
      start: Date.parse(r.start_at),
      end: Date.parse(r.end_at),
    })),
  );

  // Scheduled (non-gcal) entries overlapping the week, bucketed by
  // their project's category ('work' fallback, GUI convention). The
  // out-of-window remainder self-supplies — windows are guidelines.
  const scheduledRows = db
    .prepare(
      `SELECT te.start_at, te.end_at, COALESCE(p.category_id, 'work') AS category_id
         FROM time_entry te
         LEFT JOIN projects p ON p.id = te.project_id
        WHERE te.source != 'gcal-sync' AND te.start_at < ? AND te.end_at > ?`,
    )
    .all(weekEndIso, weekStartIso) as {
    start_at: string;
    end_at: string;
    category_id: string;
  }[];

  // Availability overrides overlapping the week. category_id NULL =
  // global (applies everywhere).
  const overrides = listAvailabilityOverrides(db, {
    from: weekStartIso,
    to: weekEndIso,
  });
  const toInterval = (o: { start: string; end: string }): Interval => ({
    start: Date.parse(o.start),
    end: Date.parse(o.end),
  });

  const categories = listCategories(db);
  const by_category: CategorySupply[] = categories.map((category, index) => {
    const windows = windowIntervals(
      weekStart,
      category.default_window,
      category.timezone,
    );

    const blocks = mergeIntervals(
      overrides
        .filter(
          (o) =>
            o.available === 0 &&
            (o.category_id === null || o.category_id === category.id),
        )
        .map(toInterval),
    );
    // Global opens go to the first category only, so the total counts
    // them once (see module header — attribution, not a wall).
    const opens = mergeIntervals(
      overrides
        .filter(
          (o) =>
            o.available === 1 &&
            (o.category_id === category.id ||
              (o.category_id === null && index === 0)),
        )
        .map(toInterval),
    );

    const eventOverlap = intersectIntervals(windows, events);
    const blockedOverlap = intersectIntervals(
      subtractIntervals(windows, events),
      blocks,
    );
    // Opened = open swaths clipped to the week, outside the window,
    // not event-occupied, and not re-blocked (block wins over open).
    const opened = subtractIntervals(
      subtractIntervals(
        subtractIntervals(intersectIntervals(opens, week), windows),
        events,
      ),
      blocks,
    );

    // Out-of-window scheduled time claims its own hours: the merged
    // entry swaths, clipped to the week, minus everything already
    // counted (window, opens) or explicitly excluded (events, blocks).
    const scheduled = mergeIntervals(
      scheduledRows
        .filter((r) => r.category_id === category.id)
        .map((r) => ({
          start: Date.parse(r.start_at),
          end: Date.parse(r.end_at),
        })),
    );
    const scheduledOutside = subtractIntervals(
      subtractIntervals(
        subtractIntervals(
          subtractIntervals(intersectIntervals(scheduled, week), windows),
          opens,
        ),
        events,
      ),
      blocks,
    );

    const window_minutes = totalMinutes(windows);
    const event_minutes = totalMinutes(eventOverlap);
    const blocked_minutes = totalMinutes(blockedOverlap);
    const opened_minutes = totalMinutes(opened);
    const scheduled_outside_minutes = totalMinutes(scheduledOutside);
    return {
      category_id: category.id,
      window_minutes,
      event_minutes,
      blocked_minutes,
      opened_minutes,
      scheduled_outside_minutes,
      supply_minutes:
        window_minutes -
        event_minutes -
        blocked_minutes +
        opened_minutes +
        scheduled_outside_minutes,
    };
  });

  const total_supply_minutes = by_category.reduce(
    (sum, c) => sum + c.supply_minutes,
    0,
  );
  // Effective assignments: explicit row or standing default per
  // envelope; snoozed (NULL) counts as 0.
  const assigned_minutes = getEnvelopes(db, weekStart).reduce(
    (sum, row) => sum + (row.assigned ?? 0),
    0,
  );

  return {
    week_start: weekStart,
    by_category,
    total_supply_minutes,
    assigned_minutes,
    to_be_assigned_minutes: total_supply_minutes - assigned_minutes,
  };
}

// ---------------------------------------------------------------------------
// Placement note — the calm out-of-window mention.
// ---------------------------------------------------------------------------

/**
 * One informational sentence about a placement's slot, or null when
 * there is nothing worth mentioning. Never a gate: the placement has
 * already happened by the time this runs. Windows are guidelines —
 * an out-of-window slot simply self-supplies (see module header) and
 * gets a passing mention; a slot overlapping an explicit `block_time`
 * gets a slightly firmer one because blocked time mints no supply.
 */
export function placementNote(
  db: DB,
  args: { start_at: string; end_at: string; project_id: string | null },
): string | null {
  const startMs = Date.parse(args.start_at);
  const endMs = Date.parse(args.end_at);
  if (!(endMs > startMs)) return null;
  const entry: Interval[] = [{ start: startMs, end: endMs }];

  const categories = listCategories(db);
  const categoryId = args.project_id
    ? ((db
        .prepare(`SELECT category_id FROM projects WHERE id = ?`)
        .get(args.project_id) as { category_id: string | null } | undefined)
        ?.category_id ?? 'work')
    : 'work';
  const category = categories.find((c) => c.id === categoryId);
  if (!category) return null;

  const overrides = listAvailabilityOverrides(db, {
    from: args.start_at,
    to: args.end_at,
  });
  const blocks = mergeIntervals(
    overrides
      .filter(
        (o) =>
          o.available === 0 &&
          (o.category_id === null || o.category_id === category.id),
      )
      .map((o) => ({ start: Date.parse(o.start), end: Date.parse(o.end) })),
  );
  if (intersectIntervals(entry, blocks).length > 0) {
    return (
      `heads up: this overlaps time you blocked off — placed anyway, ` +
      `but blocked time doesn't count as extra supply`
    );
  }

  // No window at all = the category has no hours guideline to be
  // outside of.
  if (!category.default_window) return null;

  // Expand the window over the Monday-anchored week containing the
  // slot's start; a slot straddling weeks is judged by its start week.
  const startDay = new Date(startMs).toISOString().slice(0, 10);
  const dow = new Date(`${startDay}T00:00:00Z`).getUTCDay();
  const monday = addDays(startDay, dow === 0 ? -6 : 1 - dow);
  const windows = windowIntervals(
    monday,
    category.default_window,
    category.timezone,
  );
  const opens = mergeIntervals(
    overrides
      .filter(
        (o) =>
          o.available === 1 &&
          (o.category_id === null || o.category_id === category.id),
      )
      .map((o) => ({ start: Date.parse(o.start), end: Date.parse(o.end) })),
  );
  const outside = subtractIntervals(subtractIntervals(entry, windows), opens);
  const outsideMinutes = totalMinutes(outside);
  if (outsideMinutes === 0) return null;

  const total = totalMinutes(entry);
  const portion =
    outsideMinutes === total ? 'this slot is' : `${outsideMinutes}m of this slot are`;
  return (
    `note: ${portion} outside the usual ${category.name} hours — ` +
    `that's fine, the time counts as extra ${category.name} supply this week`
  );
}
