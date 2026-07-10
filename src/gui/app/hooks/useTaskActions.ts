import { useMemo } from 'react';
import * as api from '../api';
import type { Task } from '../types';
import { useToasts } from '../components/Toasts';
import { addDays, localISODate } from '../lib/dates';

export interface TaskActions {
  complete: (task: Task) => Promise<void>;
  snooze: (task: Task, until: string | null) => Promise<void>;
  unplace: (task: Task) => Promise<void>;
}

export function snoozePresets(): { label: string; until: string | null }[] {
  const today = localISODate(new Date());
  const tomorrow = addDays(today, 1);
  const d = new Date(today + 'T00:00:00');
  const daysToMonday = ((8 - d.getDay()) % 7) || 7;
  const nextMonday = addDays(today, daysToMonday);
  return [
    { label: '+1 day', until: tomorrow },
    { label: 'Next Monday', until: nextMonday },
    { label: 'Clear snooze', until: null },
  ];
}

/**
 * Task-row actions shared by the week panel and the #/tasks page.
 * Every action refetches (server truth wins) and offers undo via the
 * inverse mutation — complete reopens to the task's prior status,
 * snooze restores the previous date, unplace re-places at the old slot.
 */
export function useTaskActions(refetch: () => Promise<void> | void): TaskActions {
  const { show } = useToasts();

  return useMemo(() => {
    const run = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        show({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        await refetch();
      }
    };

    return {
      complete: (task) =>
        run(async () => {
          const prior = task.status;
          await api.completeTask(task.id);
          const reopenTo =
            prior === 'SCHEDULED' || prior === 'IN_PROGRESS' ? prior : 'NEW';
          show({
            kind: 'info',
            message: `Completed “${task.title}”`,
            undo: async () => {
              await api.reopenTask(task.id, reopenTo);
              await refetch();
            },
          });
        }),
      snooze: (task, until) =>
        run(async () => {
          const prior = task.snooze_until;
          await api.snoozeTask(task.id, until);
          show({
            kind: 'info',
            message: until
              ? `Snoozed “${task.title}” until ${until}`
              : `Cleared snooze on “${task.title}”`,
            undo: async () => {
              await api.snoozeTask(task.id, prior);
              await refetch();
            },
          });
        }),
      unplace: (task) =>
        run(async () => {
          const { was } = await api.unplaceTask(task.id);
          show({
            kind: 'info',
            message: `Unplaced “${task.title}”`,
            undo: was
              ? async () => {
                  await api.placeTask({
                    task_id: task.id,
                    start: was.start_at,
                    end: was.end_at,
                  });
                  await refetch();
                }
              : undefined,
          });
        }),
    };
  }, [refetch, show]);
}
