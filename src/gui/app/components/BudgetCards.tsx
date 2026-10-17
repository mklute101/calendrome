import type { Budget, ProjectMeta } from '../types';
import { colorOf } from '../lib/colors';
import { budgetCardModel } from '../lib/budget-card';

/**
 * Per-project envelope cards with the #28 treatment: solid fill =
 * confirmed activity, diagonal hatch = scheduled activity, red
 * overflow keeping the same texture, and a marker at the assigned
 * line when over. Track spans max(assigned, activity); confirmed
 * fills first (it already happened), scheduled stacks after it.
 * Capped (0h included), uncapped and snoozed weeks render distinctly
 * — see `budgetCardModel` (#173). (CSS class names keep the
 * budget-era spelling for screenshot parity — see styles.css.)
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
        const color = colorOf(meta, b.project_id);
        const m = budgetCardModel(b);
        return (
          <div className={`budget-card ${m.state}`} key={b.project_id}>
            <h3 style={{ color }}>{b.project_id}</h3>
            <div className="budget-bar" style={{ '--c': color } as React.CSSProperties}>
              <div className="budget-seg spent" style={{ width: `${m.widths.confirmedIn}%` }} />
              <div className="budget-seg spent over" style={{ width: `${m.widths.confirmedOver}%` }} />
              <div className="budget-seg sched" style={{ width: `${m.widths.schedIn}%` }} />
              <div className="budget-seg sched over" style={{ width: `${m.widths.schedOver}%` }} />
              {m.markAt !== null && <div className="budget-mark" style={{ left: `${m.markAt}%` }} />}
            </div>
            <div className={`budget-label ${m.over ? 'over-budget' : ''}`}>{m.label}</div>
          </div>
        );
      })}
    </div>
  );
}
