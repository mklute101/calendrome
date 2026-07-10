import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import {
  addMeetingProjectMapping,
  listMeetingProjectMappings,
  deleteMeetingProjectMapping,
  buildMeetingProjectResolver,
} from '../src/meeting-mappings.js';
import { syncCalendarEvents } from '../src/calendar-sync.js';

function withProjects(db: any) {
  db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('acme', 'Acme', 'ACME')`).run();
  db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('glbx', 'Globex', 'GLBX')`).run();
  return db;
}

describe('meeting → project mappings (#35)', () => {
  it('adds, lists, and deletes mappings', () => {
    const db = withProjects(freshDb());
    const m = addMeetingProjectMapping(db, { pattern: 'Daily Standup', project_id: 'acme' });
    expect(m.match).toBe('contains');
    expect(listMeetingProjectMappings(db)).toHaveLength(1);
    deleteMeetingProjectMapping(db, m.id);
    expect(listMeetingProjectMappings(db)).toHaveLength(0);
  });

  it('rejects unknown projects, empty patterns, invalid match kinds, and bad regexes', () => {
    const db = withProjects(freshDb());
    expect(() =>
      addMeetingProjectMapping(db, { pattern: 'x', project_id: 'nope' }),
    ).toThrow(/not found/);
    expect(() =>
      addMeetingProjectMapping(db, { pattern: '  ', project_id: 'acme' }),
    ).toThrow(/non-empty/);
    expect(() =>
      addMeetingProjectMapping(db, { pattern: 'x', project_id: 'acme', match: 'fuzzy' as any }),
    ).toThrow(/exact\|contains\|regex/);
    expect(() =>
      addMeetingProjectMapping(db, { pattern: '(unclosed', project_id: 'acme', match: 'regex' }),
    ).toThrow(/valid regex/);
  });

  it('delete throws on unknown id', () => {
    const db = freshDb();
    expect(() => deleteMeetingProjectMapping(db, 999)).toThrow(/not found/);
  });

  it('resolver matches exact, contains, and regex case-insensitively, first rule wins', () => {
    const db = withProjects(freshDb());
    addMeetingProjectMapping(db, { pattern: 'Acme/GLBX sync', project_id: 'glbx', match: 'exact' });
    addMeetingProjectMapping(db, { pattern: 'acme', project_id: 'acme', match: 'contains' });
    addMeetingProjectMapping(db, { pattern: '^retro( |$)', project_id: 'glbx', match: 'regex' });
    const resolve = buildMeetingProjectResolver(db);

    expect(resolve('ACME/glbx SYNC')).toBe('glbx'); // exact rule, added first, wins over contains
    expect(resolve('Acme internal planning')).toBe('acme');
    expect(resolve('Retro w/ team')).toBe('glbx');
    expect(resolve('Retrospective')).toBeNull(); // regex requires word boundary
    expect(resolve('1:1 with Jordan')).toBeNull();
  });
});

describe('sync auto-assignment via mappings (#35)', () => {
  const evt = (id: string, summary: string, project_id?: string | null) => ({
    id,
    calendar_id: 'cal-work',
    summary,
    start: '2026-07-07T10:00:00Z',
    end: '2026-07-07T10:30:00Z',
    is_meeting: true,
    ...(project_id !== undefined ? { project_id } : {}),
  });
  const projectOf = (db: any, id: string) =>
    (db.prepare(`SELECT project_id FROM time_entry WHERE external_id = ?`).get(id) as any)
      ?.project_id;

  it('assigns unmatched-project events via mapping; explicit project_id wins', () => {
    const db = withProjects(freshDb());
    addMeetingProjectMapping(db, { pattern: 'standup', project_id: 'acme' });

    syncCalendarEvents(db, [
      evt('e1', 'Daily Standup'),
      evt('e2', 'Daily Standup', 'glbx'), // explicit beats mapping
      evt('e3', 'Lunch'),
    ]);

    expect(projectOf(db, 'e1')).toBe('acme');
    expect(projectOf(db, 'e2')).toBe('glbx');
    expect(projectOf(db, 'e3')).toBeNull();
  });

  it('applies mappings on re-sync so existing unassigned meetings pick up new rules', () => {
    const db = withProjects(freshDb());
    syncCalendarEvents(db, [evt('e1', 'Daily Standup')]);
    expect(projectOf(db, 'e1')).toBeNull();

    addMeetingProjectMapping(db, { pattern: 'standup', project_id: 'acme' });
    syncCalendarEvents(db, [evt('e1', 'Daily Standup')]);
    expect(projectOf(db, 'e1')).toBe('acme');
  });
});
