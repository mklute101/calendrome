/**
 * Calendar event sync — inbound mirror of Google Calendar (or any source).
 *
 * Calendrome doesn't fetch from Google itself; the planner skill calls
 * the Google Calendar MCP and pushes events here via
 * `sync_calendar_events`. Stored events power the timeline view's
 * meeting/habit overlays and the "available focus time" calculation.
 * Idempotent: re-syncing the same event id updates in place.
 *
 * Silent event loss is the failure mode this module defends against
 * (#133): the prune is guarded (empty-payload and mass-prune refusals)
 * and the result names every pruned event, so a sync can never delete
 * more than the caller pushed without saying so.
 */
import type { DB } from './db/connection.js';
import { toCanonicalUtc, toDayRange } from './day-range.js';
import { buildMeetingProjectResolver } from './meeting-mappings.js';

export interface CalendarEventInput {
  id: string;
  calendar_id: string;
  project_id?: string | null;
  summary: string;
  start: string;  // ISO 8601
  end: string;    // ISO 8601
  is_meeting?: boolean;
}

export interface CalendarEvent {
  id: string;
  calendar_id: string;
  project_id: string | null;
  summary: string;
  start: string;
  end: string;
  duration_minutes: number;
  is_meeting: number;
  synced_at: string;
  status: 'UNCONFIRMED' | 'CONFIRMED';
}

/**
 * Prune window for mirror-sync (#93). When provided, gcal-sync
 * UNCONFIRMED rows inside the window whose `external_id` is not in
 * the synced payload are deleted — the event was cancelled or moved
 * out of the window in Google Calendar. CONFIRMED rows are historical
 * and always survive; placements/habits/manual rows are never touched.
 *
 * Bound semantics (#133): bounds carrying a time component (`T`) are
 * exact timestamps — pass the verbatim `timeMin`/`timeMax` of the
 * calendar fetch and the prune scope equals the fetch scope by
 * construction. Plain dates keep the legacy inclusive-UTC-day buckets
 * (`day-range.ts`, #92). Day buckets are wider than a local-timezone
 * fetch range, which is exactly how evening events stored on the next
 * UTC day used to get pruned by a neighboring window.
 *
 * The prune is window-global, not per-calendar: it assumes the sync
 * payload is the complete truth for the window. If multiple calendar
 * feeds ever sync independently, scope the prune per feed first.
 */
export interface SyncWindow {
  from: string;
  to: string;
}

export interface SyncOptions {
  /** Permit pruning with an empty payload (a genuinely empty week). */
  allow_empty_prune?: boolean;
  /** Override the mass-prune refusal (see prune-cap guard). */
  confirm_prune?: boolean;
}

export interface PrunedEvent {
  id: string;
  summary: string;
  start: string;
}

export interface SyncResult {
  /** Events in the payload, duplicates included. */
  received: number;
  inserted: number;
  updated: number;
  /** Rows pruned by the window (0 when refused or no window). */
  deleted: number;
  /** Every pruned event, named — deletions are never silent. */
  pruned_events: PrunedEvent[];
  /**
   * Set when the prune-cap guard refused: the candidates that would
   * have been deleted. Re-run with `confirm_prune: true` if the mass
   * deletion is intended.
   */
  prune_refused?: PrunedEvent[];
  warnings: string[];
}

export function syncCalendarEvents(
  db: DB,
  events: CalendarEventInput[],
  window?: SyncWindow,
  options: SyncOptions = {},
): SyncResult {
  // Empty-payload guard (#133): a window plus zero events prunes
  // everything in the window — almost always a partial-push mistake,
  // never silently honored.
  if (window && events.length === 0 && !options.allow_empty_prune) {
    throw new Error(
      'refusing to prune with an empty payload — omit window, or pass ' +
        'allow_empty_prune: true for a genuinely empty range',
    );
  }

  // Write into the unified time_entry table. On conflict (existing
  // external_id), update only the sync-driven fields and leave confirmation
  // state (status, confirmed_at, actual_minutes, task_id) untouched.
  const upsertTimeEntry = db.prepare(`
    INSERT INTO time_entry (
      project_id, start_at, end_at, status, source, external_id, is_meeting, synced_at, notes
    ) VALUES (?, ?, ?, 'UNCONFIRMED', 'gcal-sync', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
    ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET
      project_id = excluded.project_id,
      start_at   = excluded.start_at,
      end_at     = excluded.end_at,
      is_meeting = excluded.is_meeting,
      synced_at  = excluded.synced_at,
      notes      = excluded.notes,
      updated_at = datetime('now')
  `);

  // Title-pattern auto-assignment (#35): events arriving without an
  // explicit project_id are matched against meeting_project_mappings.
  // Explicit assignment (the skill matched a prefix) always wins.
  const resolveProject = buildMeetingProjectResolver(db);

  const warnings: string[] = [];
  const uniqueIds = new Set(events.map((e) => e.id));
  if (uniqueIds.size < events.length) {
    warnings.push(
      `payload contains ${events.length - uniqueIds.size} duplicate event ` +
        'id(s) — later entries overwrote earlier ones',
    );
  }

  const result: SyncResult = {
    received: events.length,
    inserted: 0,
    updated: 0,
    deleted: 0,
    pruned_events: [],
    warnings,
  };

  const txn = db.transaction(() => {
    // Which payload ids already exist? Splits inserted/updated so the
    // caller can see duplicate-id collapse (received > inserted+updated).
    const ids = [...uniqueIds];
    const existing = new Set(
      ids.length
        ? (db
            .prepare(`
              SELECT external_id FROM time_entry
               WHERE source = 'gcal-sync'
                 AND external_id IN (${ids.map(() => '?').join(',')})
            `)
            .all(...ids) as { external_id: string }[]
          ).map((r) => r.external_id)
        : [],
    );

    const seen = new Set<string>();
    for (const e of events) {
      upsertTimeEntry.run(
        e.project_id ?? resolveProject(e.summary),
        toCanonicalUtc(e.start, `event ${e.id} start`),
        toCanonicalUtc(e.end, `event ${e.id} end`),
        e.id,
        e.is_meeting ? 1 : 0,
        e.summary,
      );
      if (seen.has(e.id)) continue; // duplicate — counted once
      seen.add(e.id);
      if (existing.has(e.id)) result.updated++;
      else result.inserted++;
    }

    if (window) {
      // Timestamp bounds prune exactly; plain dates keep day buckets
      // (see SyncWindow doc).
      const exact = window.from.includes('T') || window.to.includes('T');
      let boundsSql: string;
      let bounds: [string, string];
      if (exact) {
        boundsSql = `AND start_at >= ? AND start_at <= ?`;
        bounds = [
          toCanonicalUtc(window.from, 'window.from'),
          toCanonicalUtc(window.to, 'window.to'),
        ];
      } else {
        const { fromDay, toDay } = toDayRange(window.from, window.to);
        boundsSql = `AND DATE(start_at) >= ? AND DATE(start_at) <= ?`;
        bounds = [fromDay, toDay];
      }
      const payloadIds = [...uniqueIds];
      const notInPayload = payloadIds.length
        ? `AND external_id NOT IN (${payloadIds.map(() => '?').join(',')})`
        : '';
      const candidates = db
        .prepare(`
          SELECT external_id AS id, COALESCE(notes, '') AS summary, start_at AS start
            FROM time_entry
           WHERE source = 'gcal-sync'
             AND status = 'UNCONFIRMED'
             AND external_id IS NOT NULL
             ${boundsSql}
             ${notInPayload}
           ORDER BY start_at
        `)
        .all(...bounds, ...payloadIds) as PrunedEvent[];

      // Prune-cap guard (#133): deleting far more events than the
      // payload holds is the signature of a partial payload synced
      // against a wide window — refuse and name the candidates
      // instead of silently wiping days.
      const cap = Math.max(5, events.length);
      if (candidates.length > cap && !options.confirm_prune) {
        result.prune_refused = candidates;
        warnings.push(
          `prune refused: ${candidates.length} events would be deleted ` +
            `(payload has ${events.length}) — likely a partial payload ` +
            'synced against a wider window. Pass the full fetched payload, ' +
            'or confirm_prune: true if the deletion is intended',
        );
      } else if (candidates.length) {
        db.prepare(`
          DELETE FROM time_entry
           WHERE source = 'gcal-sync'
             AND status = 'UNCONFIRMED'
             AND external_id IN (${candidates.map(() => '?').join(',')})
        `).run(...candidates.map((c) => c.id));
        result.deleted = candidates.length;
        result.pruned_events = candidates;
      }
    }

    // Audit row (#133), inside the txn: a sync that throws mid-way
    // leaves no log row, so every row describes a sync that actually
    // committed. The week view's staleness badge reads the latest.
    db.prepare(`
      INSERT INTO sync_log (window_from, window_to, received, inserted, updated, deleted, warnings)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      window?.from ?? null,
      window?.to ?? null,
      result.received,
      result.inserted,
      result.updated,
      result.deleted,
      JSON.stringify(warnings),
    );
  });
  txn();

  return result;
}

export interface LastSync {
  synced_at: string;
  window_from: string | null;
  window_to: string | null;
  received: number;
  inserted: number;
  updated: number;
  deleted: number;
  warnings: string[];
  /** True when [from, to] (plain dates) lies inside the last window. */
  covers_range: boolean;
}

/**
 * The most recent sync_log row, judged against a date range — the
 * data behind the week view's staleness badge (#133). `covers_range`
 * is false when the viewed range wasn't inside the last sync's
 * window (or the sync had no window), so a week can't be silently
 * trusted just because *some* sync ran recently.
 */
export function getLastSync(db: DB, from: string, to: string): LastSync | null {
  const row = db
    .prepare(`
      SELECT synced_at, window_from, window_to, received, inserted, updated, deleted, warnings
        FROM sync_log
       ORDER BY id DESC
       LIMIT 1
    `)
    .get() as
    | (Omit<LastSync, 'warnings' | 'covers_range'> & { warnings: string })
    | undefined;
  if (!row) return null;
  // Date-precision heuristic: exact for the documented caller shape
  // (verbatim local-offset timeMin/timeMax); a UTC-aligned window for
  // an offset user can over-claim the last few local hours of the
  // range. Good enough for a staleness badge.
  const covers_range =
    row.window_from !== null &&
    row.window_to !== null &&
    row.window_from.slice(0, 10) <= from &&
    row.window_to.slice(0, 10) >= to;
  let warnings: string[] = [];
  try {
    warnings = JSON.parse(row.warnings);
  } catch {
    // pre-JSON or corrupted row — badge still works without them
  }
  return { ...row, warnings, covers_range };
}

export function listCalendarEvents(
  db: DB,
  from: string,
  to: string,
): CalendarEvent[] {
  // Reads gcal-sync rows from the unified time_entry table and projects
  // them into the legacy CalendarEvent shape so existing consumers (GUI
  // timeline, planner skill) keep working unchanged. `status` is included
  // so the GUI can visually flag past-UNCONFIRMED entries as "needs review".
  return db
    .prepare(
      `SELECT
         te.external_id                                       AS id,
         COALESCE(p.calendar_id, '')                          AS calendar_id,
         te.project_id                                        AS project_id,
         COALESCE(te.notes, '')                               AS summary,
         te.start_at                                          AS start,
         te.end_at                                            AS end,
         CAST(ROUND((julianday(te.end_at) - julianday(te.start_at)) * 24 * 60) AS INTEGER) AS duration_minutes,
         te.is_meeting                                        AS is_meeting,
         te.synced_at                                         AS synced_at,
         te.status                                            AS status
       FROM time_entry te
       LEFT JOIN projects p ON p.id = te.project_id
       WHERE te.source = 'gcal-sync'
         AND te.external_id IS NOT NULL
         AND te.start_at >= ?
         AND te.start_at <= ?
       ORDER BY te.start_at`,
    )
    .all(from, to) as CalendarEvent[];
}
