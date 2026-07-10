import type { Placement, ProjectMeta } from '../types';
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
import type { DragGhost, DragSource } from '../hooks/useTimelineDrag';

const cssBlock = (c: string, top: number, height: number) =>
  ({ '--c': c, top: `${top}px`, height: `${height}px` }) as React.CSSProperties;

function hourLabel(h: number): string {
  return h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
}

/**
 * Timeline view: absolute-positioned blocks on a 7-day × hourly grid.
 * Placement blocks are interactive (#24): drag the body to move, the
 * bottom edge to resize, hover for confirm/skip. Logs, habits, and
 * gcal events render without handles — the server guards are the
 * backstop, the missing affordance is the UX.
 */
export function WeekTimeline({
  days,
  meta,
  ghost,
  gridRef,
  dragging,
  onStartDrag,
  onConfirm,
  onSkip,
}: {
  days: DayBucket[];
  meta: ProjectMeta;
  ghost: DragGhost | null;
  gridRef: React.MutableRefObject<HTMLDivElement | null>;
  dragging: boolean;
  onStartDrag: (e: React.PointerEvent, source: DragSource) => void;
  onConfirm: (p: Placement) => void;
  onSkip: (p: Placement) => void;
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
      <div className="timeline-container" ref={gridRef}>
        <div className="timeline-hours">
          {Array.from({ length: HOUR_COUNT }, (_, i) => (
            <div className="timeline-hour-label" key={i}>
              {hourLabel(HOUR_START + i)}
            </div>
          ))}
        </div>
        {days.map((d, i) => {
          const isToday = d.date === todayStr;
          const showGhost = ghost && ghost.valid && ghost.dayIndex === i;
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
                  const color = colorOf(meta, p.project_id);
                  const beingDragged =
                    dragging &&
                    ghost &&
                    ghost.kind !== 'place' &&
                    isDraggedPlacement(ghost, p);
                  return (
                    <div
                      key={`p-${p.time_entry_id}`}
                      className={`timeline-block placement${isOverduePlacement(p) ? ' overdue-review' : ''}${beingDragged ? ' drag-origin' : ''}`}
                      style={cssBlock(color, top, height)}
                      onPointerDown={(e) =>
                        onStartDrag(e, { kind: 'move', placement: p, color })
                      }
                    >
                      <div className="title">{p.task_title}</div>
                      {height > 30 && (
                        <div className="meta">
                          {fmtHours(p.duration_minutes)} · {p.project_id}
                        </div>
                      )}
                      <div
                        className="block-actions"
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <button
                          className="block-action"
                          title="Confirm — this happened"
                          onClick={() => onConfirm(p)}
                        >
                          ✓
                        </button>
                        <button
                          className="block-action"
                          title="Skip — this didn't happen"
                          onClick={() => onSkip(p)}
                        >
                          ✕
                        </button>
                      </div>
                      <div
                        className="resize-handle"
                        title="Drag to resize"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          onStartDrag(e, { kind: 'resize', placement: p, color });
                        }}
                      />
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
                {showGhost && (
                  <div
                    className="timeline-block drag-ghost"
                    style={cssBlock(
                      ghost.color,
                      (ghost.startMinutes - HOUR_START * 60) * (HOUR_PX / 60),
                      durationToPx(ghost.durationMinutes),
                    )}
                  >
                    <div className="title">{ghost.label}</div>
                    <div className="meta">
                      {fmtGhostTime(ghost.startMinutes)} · {ghost.durationMinutes}m
                    </div>
                  </div>
                )}
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

function isDraggedPlacement(ghost: DragGhost, p: Placement): boolean {
  // The ghost doesn't carry the placement id; label match is enough
  // for the dim-the-origin affordance (worst case two same-titled
  // blocks both dim during the drag).
  return ghost.label === (p.task_title ?? '(untitled)');
}

function fmtGhostTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? 'a' : 'p';
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}
