/**
 * Meeting → project mapping rules (#35).
 *
 * Recurring Google Calendar events arrive with a unique id per
 * instance, so tagging individual events with a project never sticks
 * across weeks. The durable identity of a meeting series is its
 * title. These rules map title patterns to projects; `syncCalendarEvents`
 * consults them for any incoming event that doesn't carry an explicit
 * `project_id`, so recurring standups and client meetings roll up
 * into budgets and timesheets automatically.
 *
 * Matching is case-insensitive. Rules apply in id (creation) order;
 * first match wins. An explicit `project_id` on the synced event
 * always beats a mapping.
 */
import type { DB } from './db/connection.js';

export type MappingMatch = 'exact' | 'contains' | 'regex';

export interface MeetingProjectMapping {
  id: number;
  pattern: string;
  match: MappingMatch;
  project_id: string;
  created_at: string;
}

export interface AddMappingInput {
  pattern: string;
  project_id: string;
  match?: MappingMatch;
}

export function addMeetingProjectMapping(
  db: DB,
  input: AddMappingInput,
): MeetingProjectMapping {
  const match = input.match ?? 'contains';
  if (!['exact', 'contains', 'regex'].includes(match)) {
    throw new Error(`match must be one of exact|contains|regex, got: ${match}`);
  }
  if (!input.pattern || input.pattern.trim().length === 0) {
    throw new Error('pattern must be a non-empty string');
  }
  if (match === 'regex') {
    try {
      new RegExp(input.pattern, 'i');
    } catch (err) {
      throw new Error(
        `pattern is not a valid regex: ${(err as Error).message}`,
      );
    }
  }
  const project = db
    .prepare(`SELECT id FROM projects WHERE id = ?`)
    .get(input.project_id);
  if (!project) throw new Error(`project ${input.project_id} not found`);

  const result = db
    .prepare(
      `INSERT INTO meeting_project_mappings (pattern, match, project_id)
       VALUES (?, ?, ?)`,
    )
    .run(input.pattern, match, input.project_id);
  return db
    .prepare(`SELECT * FROM meeting_project_mappings WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as MeetingProjectMapping;
}

export function listMeetingProjectMappings(db: DB): MeetingProjectMapping[] {
  return db
    .prepare(`SELECT * FROM meeting_project_mappings ORDER BY id`)
    .all() as MeetingProjectMapping[];
}

export function deleteMeetingProjectMapping(db: DB, id: number): void {
  const result = db
    .prepare(`DELETE FROM meeting_project_mappings WHERE id = ?`)
    .run(id);
  if (result.changes === 0) {
    throw new Error(`meeting_project_mapping ${id} not found`);
  }
}

/**
 * Load all mapping rules once and return a resolver for event
 * summaries — sync calls this per batch, not per event. Returns the
 * first matching rule's `project_id`, or null. Invalid regexes
 * (rejected at add time, but defend against hand-edited rows) are
 * skipped.
 */
export function buildMeetingProjectResolver(
  db: DB,
): (summary: string) => string | null {
  const rules = listMeetingProjectMappings(db).map((m) => {
    let test: (s: string) => boolean;
    if (m.match === 'exact') {
      const want = m.pattern.toLowerCase();
      test = (s) => s.toLowerCase() === want;
    } else if (m.match === 'contains') {
      const want = m.pattern.toLowerCase();
      test = (s) => s.toLowerCase().includes(want);
    } else {
      try {
        const re = new RegExp(m.pattern, 'i');
        test = (s) => re.test(s);
      } catch {
        test = () => false;
      }
    }
    return { test, project_id: m.project_id };
  });

  return (summary: string) => {
    for (const rule of rules) {
      if (rule.test(summary)) return rule.project_id;
    }
    return null;
  };
}
