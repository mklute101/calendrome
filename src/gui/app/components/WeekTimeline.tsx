import type { ProjectMeta } from '../types';
import type { DayBucket } from '../lib/weekdays';
import { isOverdueEvent, isOverduePlacement } from '../lib/weekdays';
import { colorOf, UNASSIGNED_COLOR } from '../lib/colors';
import { DAYS, fmtDate, fmtHours, fmtTime, localISODate } from '../lib/dates';
import {
  HOUR_COUNT,
  HOUR_END,
  HOUR_PX,
  HOUR_START,
  TIMELINE_HEIGHT,
  durationToPx,
  timeToOffset,
} from '../lib/geometry';

const cssBlock = (c: string, top: number, height: number) =>
  ({ '--c': c, top: `${top}px`, height: `${height}px` }) as React.CSSProperties;

function hourLabel(h: number): string {
  return h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
}

/**
 * Timeline view: absolute-positioned blocks on a 7-day × hourly grid.
 * Deadline markers render in the floating strip above (never as
 * duration blocks, #79). Placement blocks become draggable in phase 3.
 */
export function WeekTimeline({
  days,
  meta,
}: {
  days: DayBucket[];
  meta: ProjectMeta;
}) {
  const todayStr = localISODate(new Date());
  const deadlines = days.flatMap((d) => d.deadlines);
  const now = new Date();
  const nowHours = now.getHours() + now.getMinutes() / 60;
  const inRange = (top: number) => top >= 0 && top < TIMELINE_HEIGHT;

  return (
    <>
      <div className="floating-tasks">
        {deadlines.map((t) => (
          <div
            key={`fd-${t.id}`}
            className="block deadline"
            style={{ '--c': colorOf(meta, t.project_id) } as React.CSSProperties}
          >
            <div className="title">{t.title}</div>
            <div className="meta">
              due {fmtDate(t.due!.slice(0, 10))} · {t.project_id}
            </div>
          </div>
        ))}
      </div>
      <div className="timeline-container">
        <div className="timeline-hours">
          {Array.from({ length: HOUR_COUNT }, (_, i) => (
            <div className="timeline-hour-label" key={i}>
              {hourLabel(HOUR_START + i)}
            </div>
          ))}
        </div>
        {days.map((d, i) => {
          const isToday = d.date === todayStr;
          return (
            <div className={`timeline-day${isToday ? ' today' : ''}`} key={d.date}>
              <div className="timeline-day-header">
                <span>
                  {DAYS[i]} {fmtDate(d.date)}
                </span>
                <span className="hours">{fmtHours(d.totalMin)}</span>
              </div>
              <div className="timeline-body" style={{ height: TIMELINE_HEIGHT }}>
                {Array.from({ length: HOUR_COUNT }, (_, h) => (
                  <div
                    className="timeline-hour-line"
                    key={h}
                    style={{ top: h * HOUR_PX }}
                  />
                ))}
                {d.habits.map((hi) => {
                  const top = timeToOffset(hi.scheduled_start);
                  if (!inRange(top)) return null;
                  const height = durationToPx(hi.habit_duration || 30);
                  return (
                    <div
                      key={`h-${hi.id}`}
                      className="timeline-block habit"
                      style={cssBlock(colorOf(meta, hi.project_id), top, height)}
                    >
                      <div className="title">{hi.habit_title}</div>
                      {height > 30 && <div className="meta">{fmtHours(hi.habit_duration)}</div>}
                    </div>
                  );
                })}
                {d.meetings.map((ce) => {
                  const top = timeToOffset(ce.start);
                  if (!inRange(top)) return null;
                  const height = durationToPx(ce.duration_minutes);
                  const c = ce.project_id ? colorOf(meta, ce.project_id) : UNASSIGNED_COLOR;
                  return (
                    <div
                      key={`m-${ce.id}`}
                      className={`timeline-block meeting${isOverdueEvent(ce) ? ' overdue-review' : ''}`}
                      style={cssBlock(c, top, height)}
                    >
                      <div className="title">{ce.summary}</div>
                      {height > 30 && (
                        <div className="meta">
                          {fmtTime(ce.start)} – {fmtTime(ce.end)}
                        </div>
                      )}
                    </div>
                  );
                })}
                {d.placed.map((p) => {
                  const top = timeToOffset(p.start_at);
                  if (!inRange(top)) return null;
                  const height = durationToPx(p.duration_minutes);
                  return (
                    <div
                      key={`p-${p.time_entry_id}`}
                      className={`timeline-block${isOverduePlacement(p) ? ' overdue-review' : ''}`}
                      style={cssBlock(colorOf(meta, p.project_id), top, height)}
                    >
                      <div className="title">{p.task_title}</div>
                      {height > 30 && (
                        <div className="meta">
                          {fmtHours(p.duration_minutes)} · {p.project_id}
                        </div>
                      )}
                    </div>
                  );
                })}
                {d.logs.map((log) => {
                  const top = timeToOffset(log.started_at);
                  if (!inRange(top)) return null;
                  const height = durationToPx(log.duration_minutes);
                  return (
                    <div
                      key={`l-${log.id}`}
                      className="timeline-block logged"
                      style={cssBlock(colorOf(meta, log.project_id), top, height)}
                    >
                      <div className="title">{log.task_title ?? log.notes ?? '(untitled)'}</div>
                      {height > 30 && <div className="meta">{fmtHours(log.duration_minutes)} logged</div>}
                    </div>
                  );
                })}
                {isToday && nowHours >= HOUR_START && nowHours < HOUR_END && (
                  <div className="now-line" style={{ top: (nowHours - HOUR_START) * HOUR_PX }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
