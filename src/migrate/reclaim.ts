import type { DB } from '../db/connection.js';
import {
  createProject,
  listProjects,
  type Project,
} from '../projects.js';
import { createTask, type Priority, type TaskStatus } from '../tasks.js';

/**
 * Reclaim.ai task export shape (subset of the public API used by the
 * importer). Only fields that affect the import are required; everything
 * else is optional so partial / messy exports don't blow up.
 */
export interface ReclaimTask {
  id?: number;
  title: string;
  notes?: string | null;
  status?: string; // NEW | SCHEDULED | IN_PROGRESS | COMPLETE | ARCHIVED | etc
  priority?: string; // P1 | P2 | P3 | P4
  timeChunksRequired?: number; // 15-min chunks
  due?: string | null;
  snoozeUntil?: string | null;
  eventCategory?: string;
}

export interface ReclaimImportOptions {
  /** Actually insert rows. When false (default), only return the plan. */
  commit?: boolean;
  /**
   * Reclaim statuses to skip entirely. By default we skip COMPLETE and
   * ARCHIVED so old finished work doesn't pollute calendrome.
   */
  skipStatuses?: string[];
  /**
   * Project to use for tasks whose title has no `PREFIX:` segment.
   * If null and no default is set, prefix-less tasks are reported as
   * unmapped and skipped.
   */
  defaultProjectId?: string | null;
  /**
   * If true, automatically create projects for any unmapped prefix
   * (id = prefix.toLowerCase(), name = prefix, prefix = prefix).
   * Useful for first-time imports; off by default so accidental garbage
   * prefixes don't litter the project list.
   */
  autoCreateProjects?: boolean;
}

export interface PlannedTaskInsert {
  project_id: string;
  title: string;
  notes: string | null;
  priority: Priority;
  status: TaskStatus;
  duration_minutes: number;
  due: string | null;
  snooze_until: string | null;
  source_id: number | null; // Reclaim id, for traceability
}

export interface ReclaimImportPlan {
  total: number;
  planned_inserts: number;
  by_project: Record<string, number>;
  by_priority: Record<Priority, number>;
  unmapped_prefixes: string[];
  skipped: { reason: string; count: number }[];
  rows: PlannedTaskInsert[];
  /** Projects that were (or would be) auto-created. */
  auto_created_projects: string[];
}

const PRIORITY_MAP: Record<string, Priority> = {
  P1: 'CRITICAL',
  P2: 'HIGH',
  P3: 'MEDIUM',
  P4: 'LOW',
};

const STATUS_MAP: Record<string, TaskStatus> = {
  NEW: 'NEW',
  SCHEDULED: 'SCHEDULED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETE: 'COMPLETE',
  COMPLETED: 'COMPLETE',
  DONE: 'COMPLETE',
  ARCHIVED: 'ARCHIVED',
};

const DEFAULT_SKIP_STATUSES = ['COMPLETE', 'COMPLETED', 'DONE', 'ARCHIVED'];

/** Strip `PREFIX:` (or `PREFIX -`, `PREFIX |`) from a title. */
export function parsePrefix(title: string): {
  prefix: string | null;
  cleanTitle: string;
} {
  const match = title.match(/^([A-Z][A-Z0-9]{1,9})\s*[:|\-]\s*(.+)$/);
  if (!match) return { prefix: null, cleanTitle: title.trim() };
  return { prefix: match[1], cleanTitle: match[2].trim() };
}

function bumpCount(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Build the import plan without touching the database. Pass the same
 * options to `importReclaimTasks` to actually commit. This is the function
 * to call for a dry-run preview.
 */
export function planReclaimImport(
  db: DB,
  tasks: ReclaimTask[],
  options: ReclaimImportOptions = {},
): ReclaimImportPlan {
  const skipStatuses = options.skipStatuses ?? DEFAULT_SKIP_STATUSES;
  const skipSet = new Set(skipStatuses.map((s) => s.toUpperCase()));

  const existingProjects = listProjects(db);
  const prefixToProjectId = new Map<string, string>();
  for (const p of existingProjects) {
    prefixToProjectId.set(p.prefix.toUpperCase(), p.id);
  }

  const skippedCounts: Record<string, number> = {};
  const unmappedPrefixes = new Set<string>();
  const byProject: Record<string, number> = {};
  const byPriority: Record<Priority, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  };
  const autoCreatedPrefixes = new Set<string>();
  const rows: PlannedTaskInsert[] = [];

  for (const t of tasks) {
    if (!t.title || typeof t.title !== 'string') {
      bumpCount(skippedCounts, 'missing title');
      continue;
    }

    const rawStatus = (t.status ?? 'NEW').toUpperCase();
    if (skipSet.has(rawStatus)) {
      bumpCount(skippedCounts, `status=${rawStatus}`);
      continue;
    }
    const status = STATUS_MAP[rawStatus] ?? 'NEW';

    const { prefix, cleanTitle } = parsePrefix(t.title);

    let projectId: string | null = null;
    if (prefix) {
      const upper = prefix.toUpperCase();
      projectId =
        prefixToProjectId.get(upper) ??
        (options.autoCreateProjects ? upper.toLowerCase() : null);

      if (!projectId) {
        unmappedPrefixes.add(upper);
        bumpCount(skippedCounts, `unmapped prefix ${upper}`);
        continue;
      }

      if (
        options.autoCreateProjects &&
        !prefixToProjectId.has(upper)
      ) {
        autoCreatedPrefixes.add(upper);
      }
    } else {
      if (!options.defaultProjectId) {
        bumpCount(skippedCounts, 'no prefix and no defaultProjectId');
        continue;
      }
      projectId = options.defaultProjectId;
    }

    const priority = PRIORITY_MAP[(t.priority ?? 'P4').toUpperCase()] ?? 'LOW';
    const chunks = typeof t.timeChunksRequired === 'number'
      ? t.timeChunksRequired
      : 2; // default 30 min = 2 chunks
    const duration = Math.max(15, chunks * 15);

    rows.push({
      project_id: projectId,
      title: cleanTitle,
      notes: t.notes ?? null,
      priority,
      status,
      duration_minutes: duration,
      due: t.due ?? null,
      snooze_until: t.snoozeUntil ?? null,
      source_id: t.id ?? null,
    });

    bumpCount(byProject, projectId);
    byPriority[priority]++;
  }

  const skipped = Object.entries(skippedCounts).map(([reason, count]) => ({
    reason,
    count,
  }));

  return {
    total: tasks.length,
    planned_inserts: rows.length,
    by_project: byProject,
    by_priority: byPriority,
    unmapped_prefixes: [...unmappedPrefixes].sort(),
    skipped,
    rows,
    auto_created_projects: [...autoCreatedPrefixes].sort(),
  };
}

/**
 * Plan the import, then commit it to the database. Wraps the whole insert
 * in a transaction so a partial failure leaves no rows behind.
 *
 * Returns the same plan shape as `planReclaimImport` so callers can show
 * a "before/after" report.
 */
export function importReclaimTasks(
  db: DB,
  tasks: ReclaimTask[],
  options: ReclaimImportOptions = {},
): ReclaimImportPlan {
  const plan = planReclaimImport(db, tasks, options);

  if (options.commit !== true) {
    return plan;
  }

  const tx = db.transaction((rows: PlannedTaskInsert[]) => {
    // Auto-create any new projects first
    if (options.autoCreateProjects && plan.auto_created_projects.length > 0) {
      const existing = new Set(
        listProjects(db).map((p: Project) => p.prefix.toUpperCase()),
      );
      for (const prefix of plan.auto_created_projects) {
        if (!existing.has(prefix)) {
          createProject(db, {
            id: prefix.toLowerCase(),
            name: prefix,
            prefix,
          });
        }
      }
    }

    for (const row of rows) {
      const task = createTask(db, {
        project_id: row.project_id,
        title: row.title,
        notes: row.notes,
        priority: row.priority,
        duration_minutes: row.duration_minutes,
        due: row.due,
        snooze_until: row.snooze_until,
      });
      // Status is set after creation since createTask defaults to NEW.
      // Reclaim's COMPLETE/ARCHIVED are filtered upstream by skipStatuses,
      // so the only non-NEW values reaching here are SCHEDULED / IN_PROGRESS,
      // both legal direct transitions from NEW.
      if (row.status !== 'NEW') {
        db.prepare(
          "UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(row.status, task.id);
      }
    }
  });

  tx(plan.rows);
  return plan;
}
