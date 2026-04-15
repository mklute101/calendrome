import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function migrate(db: DB): void {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
}
