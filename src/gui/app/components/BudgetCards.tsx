import type { Budget, ProjectMeta } from '../types';
import { colorOf } from '../lib/colors';
import { fmtHours } from '../lib/dates';

/**
 * Per-project envelope cards with the #28 treatment: solid fill =
 * confirmed activity, diagonal hatch = scheduled activity, red
 * overflow keeping the same texture, and a marker at the assigned
 * line when over. Track spans max(assigned, activity); confirmed
 * fills first (it already happened), scheduled stacks after it.
 * (CSS class names keep the budget-era spelling for screenshot
 * parity — see styles.css.)
 */
export function BudgetCards({
  budgets,
  meta,
}: {
  budgets: Budget[];
  meta: ProjectMeta;
}) {
  return (
    <div className="budgets">
      {budgets.map((b) => {
        const assigned = b.assigned_minutes;
        const confirmed = b.confirmed_minutes;
        const sched = b.scheduled_minutes;
        const activity = confirmed + sched;
        const color = colorOf(meta, b.project_id);

        const track = assigned ? Math.max(assigned, activity) : activity;
        const w = (m: number) => (track ? (m / track) * 100 : 0);
        const confirmedIn = assigned ? Math.min(confirmed, assigned) : confirmed;
        const schedIn = assigned
          ? Math.min(sched, Math.max(0, assigned - confirmed))
          : sched;
        const over = assigned ? activity > assigned : false;
        const overLabel = over
          ? ` (+${Math.round((activity / assigned!) * 100 - 100)}%)`
          : '';

        return (
          <div className="budget-card" key={b.project_id}>
            <h3 style={{ color }}>{b.project_id}</h3>
            <div className="budget-bar" style={{ '--c': color } as React.CSSProperties}>
              <div className="budget-seg spent" style={{ width: `${w(confirmedIn)}%` }} />
              <div className="budget-seg spent over" style={{ width: `${w(confirmed - confirmedIn)}%` }} />
              <div className="budget-seg sched" style={{ width: `${w(schedIn)}%` }} />
              <div className="budget-seg sched over" style={{ width: `${w(sched - schedIn)}%` }} />
              {over && <div className="budget-mark" style={{ left: `${w(assigned!)}%` }} />}
            </div>
            <div className={`budget-label ${over ? 'over-budget' : ''}`}>
              {fmtHours(confirmed)} + {fmtHours(sched)} activity ·{' '}
              {assigned ? fmtHours(assigned) : '∞'} assigned{overLabel}
            </div>
          </div>
        );
      })}
    </div>
  );
}
