import type { Project, ProjectMeta } from '../types';

export const PALETTE = [
  '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
  '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#d2a8ff',
];

export const UNASSIGNED_COLOR = '#8b949e';

/** Build the projectId → {name, color, category_id} map from /api/projects. */
export function buildProjectMeta(projects: Project[]): ProjectMeta {
  const meta: ProjectMeta = {};
  projects.forEach((p, i) => {
    meta[p.id] = {
      name: p.name,
      color: p.color || PALETTE[i % PALETTE.length],
      // Treat missing category_id as 'work' to match the migration backfill.
      category_id: p.category_id || 'work',
    };
  });
  return meta;
}

export function colorOf(meta: ProjectMeta, projectId: string | null): string {
  if (!projectId) return UNASSIGNED_COLOR;
  return meta[projectId]?.color ?? UNASSIGNED_COLOR;
}
