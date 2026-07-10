/**
 * Pointer-based drag system for the timeline (#24). No drag library:
 * HTML5 DnD can't do smooth snapped ghosts, so this is raw pointer
 * events with a 4px threshold (clicks stay clicks), a 15-minute snap
 * grid, Escape-to-cancel, and drop-outside-cancels.
 *
 * Three drag kinds share one state machine:
 *   move   — grab a placement block's body, drop at a new day+time
 *   resize — grab the bottom edge, adjust the end (min 15 min)
 *   place  — drag a task row from the panel onto the timeline
 */
import { useCallback, useRef, useState } from 'react';
import type { Placement, Task } from '../types';
import {
  HOUR_END,
  HOUR_START,
  SNAP_MINUTES,
  offsetToMinutes,
  pxToMinutes,
} from '../lib/geometry';

export type DragSource =
  | { kind: 'move'; placement: Placement; color: string }
  | { kind: 'resize'; placement: Placement; color: string }
  | { kind: 'place'; task: Task; color: string };

export interface DragGhost {
  kind: DragSource['kind'];
  dayIndex: number;
  /** Minutes since local midnight, snapped. */
  startMinutes: number;
  durationMinutes: number;
  label: string;
  color: string;
  valid: boolean;
}

export interface DropTarget {
  dayIndex: number;
  startMinutes: number;
  durationMinutes: number;
}

const THRESHOLD_PX = 4;

function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

export function useTimelineDrag(opts: {
  onDrop: (source: DragSource, target: DropTarget) => void;
  onDragStateChange?: (active: boolean) => void;
}) {
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const session = useRef<{
    source: DragSource;
    startX: number;
    startY: number;
    grabOffsetY: number;
    passedThreshold: boolean;
    ghost: DragGhost | null;
    cleanup: () => void;
  } | null>(null);

  const startDrag = useCallback(
    (e: React.PointerEvent, source: DragSource) => {
      if (e.button !== 0) return;
      e.preventDefault();

      const label =
        source.kind === 'place'
          ? source.task.title
          : (source.placement.task_title ?? '(untitled)');
      const duration =
        source.kind === 'place'
          ? source.task.duration_minutes
          : source.placement.duration_minutes;

      const blockRect =
        source.kind !== 'place'
          ? (e.currentTarget.closest('.timeline-block') ?? e.currentTarget).getBoundingClientRect()
          : null;
      const grabOffsetY = blockRect ? e.clientY - blockRect.top : 0;

      const onMove = (ev: PointerEvent) => {
        const s = session.current;
        if (!s) return;
        if (!s.passedThreshold) {
          if (
            Math.abs(ev.clientX - s.startX) < THRESHOLD_PX &&
            Math.abs(ev.clientY - s.startY) < THRESHOLD_PX
          ) {
            return;
          }
          s.passedThreshold = true;
          opts.onDragStateChange?.(true);
          document.body.classList.add('dragging');
        }

        const grid = gridRef.current;
        const body = grid?.querySelector('.timeline-body');
        if (!grid || !body) return;
        const gridRect = grid.getBoundingClientRect();
        const bodyTop = body.getBoundingClientRect().top;
        const gutter = 50;
        const colWidth = (gridRect.width - gutter) / 7;

        const x = ev.clientX - gridRect.left - gutter;
        const rawDay = Math.floor(x / colWidth);
        const dayIndex = Math.max(0, Math.min(6, rawDay));
        const inGridX = x >= 0 && x <= colWidth * 7;
        const y = ev.clientY - bodyTop;

        let startMinutes: number;
        let durationMinutes: number;
        if (s.source.kind === 'resize') {
          const p = s.source.placement;
          startMinutes = minutesOfDay(p.start_at);
          const rawDur = pxToMinutes(y) - (startMinutes - HOUR_START * 60);
          durationMinutes = Math.max(
            SNAP_MINUTES,
            Math.round(rawDur / SNAP_MINUTES) * SNAP_MINUTES,
          );
        } else {
          startMinutes = offsetToMinutes(y - s.grabOffsetY);
          durationMinutes = duration;
        }
        // Keep the block inside the visible day.
        startMinutes = Math.min(startMinutes, HOUR_END * 60 - SNAP_MINUTES);
        if (startMinutes + durationMinutes > HOUR_END * 60) {
          durationMinutes =
            s.source.kind === 'resize'
              ? HOUR_END * 60 - startMinutes
              : durationMinutes;
        }

        const valid = inGridX && y > -20 && startMinutes >= HOUR_START * 60;
        const g: DragGhost = {
          kind: s.source.kind,
          dayIndex: s.source.kind === 'resize'
            ? dayIndexOf(s.source.placement)
            : dayIndex,
          startMinutes,
          durationMinutes,
          label,
          color: s.source.color,
          valid,
        };
        s.ghost = g;
        setGhost(g);
      };

      const finish = (dropped: boolean) => {
        const s = session.current;
        if (!s) return;
        s.cleanup();
        session.current = null;
        setGhost(null);
        document.body.classList.remove('dragging');
        opts.onDragStateChange?.(false);
        if (dropped && s.passedThreshold && s.ghost?.valid) {
          opts.onDrop(s.source, {
            dayIndex: s.ghost.dayIndex,
            startMinutes: s.ghost.startMinutes,
            durationMinutes: s.ghost.durationMinutes,
          });
        }
      };

      const onUp = () => finish(true);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') finish(false);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('keydown', onKey);
      session.current = {
        source,
        startX: e.clientX,
        startY: e.clientY,
        grabOffsetY,
        passedThreshold: false,
        ghost: null,
        cleanup: () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('keydown', onKey);
        },
      };
    },
    [opts],
  );

  return { ghost, gridRef, startDrag, dragging: ghost !== null };
}

function dayIndexOf(p: Placement): number {
  // Day index within the rendered week comes from the block's own
  // date — resize never changes the day.
  const d = new Date(p.start_at);
  const dow = d.getDay();
  return dow === 0 ? 6 : dow - 1; // Mon=0 … Sun=6
}
