import Database from 'better-sqlite3';

export type DB = Database.Database;

export function openDatabase(path: string = ':memory:'): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
