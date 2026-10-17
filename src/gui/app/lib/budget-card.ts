import type { Budget } from '../types';
import { fmtHours } from './dates';

/**
 * Pure layout + label model for one budget card (#28 treatment,
 * #173 states). Three assignment states stay distinct:
 *   - capped (a number, 0 included): track spans max(cap, activity),
 *     overflow past the cap is red with a marker at the cap line — a
 *     real 0h cap makes any activity overflow;
 *   - uncapped (`assigned_minutes` NULL, not snoozed): no cap line,
 *     the label reads "∞ assigned";
 *   - snoozed (`snoozed: true`, `assigned_minutes` NULL): unfunded for
 *     the week; activity draws plain, never as overflow, and the label
 *     says "snoozed".
 */
export interface BudgetCardModel {
  state: 'capped' | 'uncapped' | 'snoozed';
  /** Segment widths in percent of the track. */
  widths: { confirmedIn: number; confirmedOver: number; schedIn: number; schedOver: number };
  over: boolean;
  /** Marker position (percent) when over; null otherwise. */
  markAt: number | null;
  label: string;
}

export function budgetCardModel(b: Budget): BudgetCardModel {
  const confirmed = b.confirmed_minutes;
  const sched = b.scheduled_minutes;
  const activity = confirmed + sched;
  const state: BudgetCardModel['state'] = b.snoozed
    ? 'snoozed'
    : b.assigned_minutes === null
      ? 'uncapped'
      : 'capped';
  const cap = state === 'capped' ? (b.assigned_minutes as number) : null;

  const track = cap !== null ? Math.max(cap, activity) : activity;
  const w = (m: number) => (track ? (m / track) * 100 : 0);
  const confirmedIn = cap !== null ? Math.min(confirmed, cap) : confirmed;
  const schedIn = cap !== null ? Math.min(sched, Math.max(0, cap - confirmed)) : sched;
  const over = cap !== null && activity > cap;

  let assignedText: string;
  if (state === 'snoozed') assignedText = 'snoozed';
  else if (state === 'uncapped') assignedText = '∞ assigned';
  else assignedText = `${fmtHours(cap as number)} assigned`;
  const overLabel =
    over && cap !== null
      ? cap > 0
        ? ` (+${Math.round((activity / cap) * 100 - 100)}%)`
        : ' (over a 0h cap)'
      : '';

  return {
    state,
    widths: {
      confirmedIn: w(confirmedIn),
      confirmedOver: w(confirmed - confirmedIn),
      schedIn: w(schedIn),
      schedOver: w(sched - schedIn),
    },
    over,
    markAt: over && cap !== null ? w(cap) : null,
    label: `${fmtHours(confirmed)} + ${fmtHours(sched)} activity · ${assignedText}${overLabel}`,
  };
}
