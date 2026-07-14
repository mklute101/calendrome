/**
 * Timeline geometry — the px↔time math shared by rendering and (in
 * phase 3) the drag system, which inverts it: pixel offsets from a
 * pointer become snapped wall-clock times.
 */

export const HOUR_START = 7; // 7 AM
export const HOUR_END = 22; // 10 PM
export const HOUR_COUNT = HOUR_END - HOUR_START;
export const HOUR_PX = 60;
export const TIMELINE_HEIGHT = HOUR_COUNT * HOUR_PX;
export const SNAP_MINUTES = 15;

/** Local wall-clock time of an ISO timestamp → px from the top of the timeline body. */
export function timeToOffset(isoStr: string): number {
  const d = new Date(isoStr);
  const hours = d.getHours() + d.getMinutes() / 60;
  return (hours - HOUR_START) * HOUR_PX;
}

export function durationToPx(minutes: number): number {
  return (minutes / 60) * HOUR_PX;
}

/** Inverse of timeToOffset: px from the top → minutes since local midnight, snapped. */
export function offsetToMinutes(y: number): number {
  const raw = HOUR_START * 60 + (y / HOUR_PX) * 60;
  const snapped = Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
  return Math.max(HOUR_START * 60, Math.min(HOUR_END * 60, snapped));
}

export function pxToMinutes(px: number): number {
  return (px / HOUR_PX) * 60;
}

/** Build an ISO timestamp for local `dateStr` (YYYY-MM-DD) at `minutes` since midnight. */
export function localDateTimeIso(dateStr: string, minutes: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60).toISOString();
}
