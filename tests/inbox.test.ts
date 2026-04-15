import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { inboxAdd, inboxList, inboxNext, inboxProcess } from '../src/inbox.js';
import { listTasks } from '../src/tasks.js';

function setup() {
  const db = freshDb();
  createProject(db, { id: 'san', name: 'SAN', prefix: 'SAN' });
  return db;
}

describe('inbox', () => {
  it('inboxAdd creates a row with processed=0', () => {
    const db = setup();
    const item = inboxAdd(db, { title: 'thing', notes: null });
    expect(item.title).toBe('thing');
    expect(item.processed).toBe(0);
    expect(item.created_at).toBeTruthy();
  });

  it('inboxList returns only unprocessed items', async () => {
    const db = setup();
    inboxAdd(db, { title: 'first', notes: null });
    await new Promise((r) => setTimeout(r, 10));
    const second = inboxAdd(db, { title: 'second', notes: null });
    inboxProcess(db, second.id, 'san');

    const list = inboxList(db);
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('first');
  });

  it('inboxNext returns oldest unprocessed item', async () => {
    const db = setup();
    const first = inboxAdd(db, { title: 'first', notes: null });
    await new Promise((r) => setTimeout(r, 1100));
    inboxAdd(db, { title: 'second', notes: null });

    const next = inboxNext(db);
    expect(next).not.toBeNull();
    expect(next!.id).toBe(first.id);
  });

  it('inboxProcess creates a task in the project and flips processed', () => {
    const db = setup();
    const item = inboxAdd(db, { title: 'do laundry', notes: 'whites' });
    const task = inboxProcess(db, item.id, 'san');
    expect(task.project_id).toBe('san');
    expect(task.title).toBe('do laundry');

    expect(listTasks(db, { project_id: 'san' }).length).toBe(1);
    expect(inboxList(db).length).toBe(0);
  });

  it('throws when processing an already-processed item', () => {
    const db = setup();
    const item = inboxAdd(db, { title: 'x', notes: null });
    inboxProcess(db, item.id, 'san');
    expect(() => inboxProcess(db, item.id, 'san')).toThrow();
  });

  it('inboxNext returns null when empty', () => {
    const db = setup();
    expect(inboxNext(db)).toBeNull();
  });
});
