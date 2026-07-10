import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProjects, fetchWeek } from '../api';
import type { ProjectMeta, WeekPayload } from '../types';
import { buildProjectMeta } from '../lib/colors';

/**
 * Week payload + project metadata for a given Monday. Refetch is
 * exposed for mutations (phase 3) and guarded by a fetch-sequence
 * counter so an out-of-order response never overwrites newer data.
 */
export function useWeekData(weekStart: string) {
  const [data, setData] = useState<WeekPayload | null>(null);
  const [meta, setMeta] = useState<ProjectMeta>({});
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refetch = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const [projects, week] = await Promise.all([
        fetchProjects(),
        fetchWeek(weekStart),
      ]);
      if (mySeq !== seq.current) return; // stale response — drop it
      setMeta(buildProjectMeta(projects));
      setData(week);
      setError(null);
    } catch (err) {
      if (mySeq !== seq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [weekStart]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  /**
   * Optimistic overlay for drag interactions: patch the local payload
   * immediately so the dropped block doesn't snap back while the POST
   * is in flight. The following refetch is authoritative.
   */
  const applyLocal = useCallback((fn: (d: WeekPayload) => WeekPayload) => {
    setData((d) => (d ? fn(d) : d));
  }, []);

  return { data, meta, error, refetch, applyLocal };
}
