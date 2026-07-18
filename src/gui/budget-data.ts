/**
 * Budget-view payload assembly (#106 M2).
 *
 * Extracted from the `/api/envelopes` and `/api/moves` routes so the
 * payload contracts are unit-testable without the Express server —
 * the same split as `week-data.ts` / `tasks-data.ts`.
 *
 * The one enrichment over `getEnvelopes`: each row carries the
 * `project_id` it belongs to (a project envelope is its own project;
 * goal/habit envelopes resolve through their tables), so the client
 * can group rows by category → project with the same project meta the
 * dashboard already builds. Pure read-side sugar — no mutation logic
 * lives here.
 */
import type { DB } from '../db/connection.js';
import {
  getEnvelopes,
  listMoves,
  type EnvelopeMove,
  type EnvelopeRow,
} from '../assignments.js';

export interface BudgetEnvelopeRow extends EnvelopeRow {
  /** Owning project — the grouping key for the budget view. */
  project_id: string;
}

export interface EnvelopesPayload {
  week: string;
  envelopes: BudgetEnvelopeRow[];
}

export interface MovesPayload {
  week: string;
  moves: EnvelopeMove[];
}

/** `/api/envelopes` payload: envelope rows + the week echo. */
export function buildEnvelopesPayload(db: DB, week: string): EnvelopesPayload {
  const goalProject = db.prepare('SELECT project_id FROM goals WHERE id = ?');
  const habitProject = db.prepare('SELECT project_id FROM habits WHERE id = ?');
  const envelopes = getEnvelopes(db, week).map((row): BudgetEnvelopeRow => {
    let project_id = row.envelope_id;
    if (row.envelope_type !== 'project') {
      const stmt = row.envelope_type === 'goal' ? goalProject : habitProject;
      const owner = stmt.get(Number(row.envelope_id)) as
        | { project_id: string }
        | undefined;
      project_id = owner?.project_id ?? row.envelope_id;
    }
    return { ...row, project_id };
  });
  return { week, envelopes };
}

/** `/api/moves` payload: Recent Moves for the week, newest first. */
export function buildMovesPayload(db: DB, week: string): MovesPayload {
  return { week, moves: listMoves(db, week) };
}
