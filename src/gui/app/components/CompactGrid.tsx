import type { Goal, ProjectMeta } from '../types';
import type { DayBucket } from '../lib/weekdays';
import { goalChip, isOverdueEvent, isOverduePlacement, placementLabel } from '../lib/weekdays';
import { colorOf, UNASSIGNED_COLOR } from '../lib/colors';
import { DAYS, fmtDate, fmtHours, fmtTime, localISODate } from '../lib/dates';

const cssColor = (c: string) => ({ '--c': c } as React.CSSProperties);

/** Compact view: 7 columns of stacked lists — meetings, habits, placements, deadlines, logs. */
export function CompactGrid({
  days,
  meta,
  goalsById,
}: {
  days: DayBucket[];
  meta: ProjectMeta;
  goalsById: Record<number, Goal>;
}) {
  const todayStr = localISODate(new Date());
  return (
    <div className="week-grid">
      {days.map((d, i) => {
        const empty =
          !d.meetings.length &&
          !d.habits.length &&
          !d.placed.length &&
          !d.deadlines.length &&
          !d.logs.length;
        return (
          <div className={`day-col${d.date === todayStr ? ' today' : ''}`} key={d.date}>
            <div className="day-header">
              <span className="name">
                {DAYS[i]} {fmtDate(d.date)}
              </span>
              <span className="hours">{fmtHours(d.totalMin)}</span>
            </div>
            <div className="day-body">
              {d.meetings.map((ce) => (
                <div
                  key={`m-${ce.id}`}
                  className={`block meeting${isOverdueEvent(ce) ? ' overdue-review' : ''}`}
                  style={cssColor(ce.project_id ? colorOf(meta, ce.project_id) : UNASSIGNED_COLOR)}
                >
                  <div className="title">{ce.summary}</div>
                  <div className="meta">
                    {fmtTime(ce.start)} – {fmtTime(ce.end)}
                  </div>
                </div>
              ))}
              {d.habits.map((hi) => (
                <div key={`h-${hi.id}`} className="block habit" style={cssColor(colorOf(meta, hi.project_id))}>
                  <div className="title">{hi.habit_title}</div>
                  <div className="meta">{fmtHours(hi.habit_duration)}</div>
                </div>
              ))}
              {d.placed.map((p) => {
                const goal = p.goal_id != null ? goalsById[p.goal_id] : undefined;
                return (
                  <div
                    key={`p-${p.time_entry_id}`}
                    className={`block${p.goal_id != null ? ' goal' : ''}${isOverduePlacement(p) ? ' overdue-review' : ''}`}
                    style={cssColor(colorOf(meta, p.project_id))}
                  >
                    <div className="title">{placementLabel(p)}</div>
                    <div className="meta">
                      {fmtHours(p.duration_minutes)}
                      {p.priority ? ` · ${p.priority}` : ''} · {p.project_id}
                      {goal && (
                        <span className="goal-chip" title="Bucket progress: confirmed / target">
                          {goalChip(goal.progress)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {d.deadlines.map((t) => (
                <div key={`d-${t.id}`} className="block deadline" style={cssColor(colorOf(meta, t.project_id))}>
                  <div className="title">{t.title}</div>
                  <div className="meta">due · {t.project_id}</div>
                </div>
              ))}
              {d.logs.map((tl) => (
                <div key={`l-${tl.id}`} className="block logged" style={cssColor(colorOf(meta, tl.project_id))}>
                  <div className="title">{tl.task_title ?? tl.goal_title ?? tl.notes ?? '(untitled)'}</div>
                  <div className="meta">
                    {fmtHours(tl.duration_minutes)} logged at {fmtTime(tl.started_at)}
                  </div>
                </div>
              ))}
              {empty && <div className="empty">No items</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
