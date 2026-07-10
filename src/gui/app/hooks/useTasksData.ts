import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProjects, fetchTasks } from '../api';
import type { ProjectMeta, Task } from '../types';
import { buildProjectMeta } from '../lib/colors';

/** Pending tasks + project metadata for the panel and #/tasks page. */
export function useTasksData() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [meta, setMeta] = useState<ProjectMeta>({});
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refetch = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const [projects, payload] = await Promise.all([fetchProjects(), fetchTasks()]);
      if (mySeq !== seq.current) return;
      setMeta(buildProjectMeta(projects));
      setTasks(payload.tasks ?? []);
      setError(null);
    } catch (err) {
      if (mySeq !== seq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { tasks, meta, error, refetch };
}
