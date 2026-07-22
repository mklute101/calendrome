import type { LastSync } from '../types';

/**
 * Calendar import staleness badge (#133). Calendrome never fetches
 * Google Calendar itself — a planner skill pushes events in — so the
 * week view must show when that last happened instead of being
 * silently trusted. Amber when the last sync is old or didn't cover
 * the viewed week; red when it carried warnings (refused prunes,
 * duplicate-id collapse).
 */
export function SyncBadge({ lastSync }: { lastSync: LastSync | null }) {
  if (!lastSync) {
    return (
      <span className="sync-badge stale" title="No calendar sync recorded — run a planner session to import Google Calendar">
        calendar never synced
      </span>
    );
  }
  const ageMs = Date.now() - Date.parse(lastSync.synced_at);
  const stale = ageMs > 24 * 60 * 60 * 1000 || !lastSync.covers_range;
  const warned = lastSync.warnings.length > 0;
  const counts = `${lastSync.received} received, ${lastSync.inserted} new, ${lastSync.updated} updated, ${lastSync.deleted} pruned`;
  const title = warned
    ? `Last sync had warnings: ${lastSync.warnings.join('; ')} (${counts})`
    : lastSync.covers_range
      ? `Last calendar import: ${lastSync.synced_at} (${counts})`
      : `Last sync (${lastSync.synced_at}) did not cover this week — its window was ${lastSync.window_from ?? '—'} … ${lastSync.window_to ?? '—'}`;
  const cls = warned ? 'sync-badge warned' : stale ? 'sync-badge stale' : 'sync-badge';
  return (
    <span className={cls} title={title}>
      {lastSync.covers_range
        ? `calendar synced ${fmtAge(ageMs)} ago`
        : 'week not covered by last sync'}
    </span>
  );
}

function fmtAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
