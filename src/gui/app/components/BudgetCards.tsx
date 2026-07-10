import type { Budget, ProjectMeta } from '../types';
import { colorOf } from '../lib/colors';
import { fmtHours } from '../lib/dates';

/**
 * Per-project budget cards with the #28 treatment: solid fill =
 * spent (done), diagonal hatch = scheduled (planned), red overflow
 * keeping the same texture, and a marker at the budget line when
 * over. Track spans max(budget, used); spent fills first (it already
 * happened), scheduled stacks after it.
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
        const alloc = b.allocated_minutes;
        const spent = b.spent_minutes;
        const sched = b.scheduled_minutes;
        const used = spent + sched;
        const color = colorOf(meta, b.project_id);

        const track = alloc ? Math.max(alloc, used) : used;
        const w = (m: number) => (track ? (m / track) * 100 : 0);
        const spentIn = alloc ? Math.min(spent, alloc) : spent;
        const schedIn = alloc ? Math.min(sched, Math.max(0, alloc - spent)) : sched;
        const over = alloc ? used > alloc : false;
        const overLabel = over
          ? ` (+${Math.round((used / alloc!) * 100 - 100)}%)`
          : '';

        return (
          <div className="budget-card" key={b.project_id}>
            <h3 style={{ color }}>{b.project_id}</h3>
            <div className="budget-bar" style={{ '--c': color } as React.CSSProperties}>
              <div className="budget-seg spent" style={{ width: `${w(spentIn)}%` }} />
              <div className="budget-seg spent over" style={{ width: `${w(spent - spentIn)}%` }} />
              <div className="budget-seg sched" style={{ width: `${w(schedIn)}%` }} />
              <div className="budget-seg sched over" style={{ width: `${w(sched - schedIn)}%` }} />
              {over && <div className="budget-mark" style={{ left: `${w(alloc!)}%` }} />}
            </div>
            <div className={`budget-label ${over ? 'over-budget' : ''}`}>
              {fmtHours(spent)} done · {fmtHours(sched)} planned ·{' '}
              {alloc ? fmtHours(alloc) : '∞'} budget{overLabel}
            </div>
          </div>
        );
      })}
    </div>
  );
}
