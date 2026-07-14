/**
 * Local-timezone date math for week navigation.
 *
 * Never use toISOString() for day bucketing: it shifts to UTC, so
 * evenings (UTC-) label tomorrow as today and mornings (UTC+) label
 * yesterday (#82).
 */

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function localISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getMonday(d: Date): string {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
  dt.setDate(diff);
  return localISODate(dt);
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localISODate(d);
}

export function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function fmtHours(min: number): string {
  if (!min) return '0h';
  const h = min / 60;
  return Number(h.toFixed(1)) + 'h';
}

export function fmtDuration(min: number): string {
  const m = Number(min) || 0;
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? h + 'h ' + rem + 'm' : h + 'h';
}
