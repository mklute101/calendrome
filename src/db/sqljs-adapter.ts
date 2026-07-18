/**
 * sql.js (WASM) adapter — implements the `DB` interface from
 * `./types.ts` on top of a sql.js `Database`, so every core function
 * (placement, mutations, week payload assembly…) runs unchanged in
 * the browser. Powers the zero-install playground demo on the
 * website; also runs under node in vitest, which is how the
 * cross-engine parity tests work.
 *
 * Scope mirrors the interface deliberately: positional `?` binding,
 * `run`/`get`/`all`, `exec`, `pragma`, better-sqlite3-style
 * `transaction(fn)`. Statements are prepared per call and always
 * freed (fine at demo scale; sql.js has no statement cache worth
 * fighting for).
 *
 * Browser-safe: no node imports. The caller owns sql.js
 * initialization (loading the WASM binary) and passes the raw
 * `Database` in.
 */
import type { Database as SqlJsDatabase, BindParams } from 'sql.js';
import type { DB, RunResult, Statement } from './types.js';

/** Narrow arbitrary params to what sql.js can bind, failing loudly. */
function toBindParams(sql: string, params: unknown[]): BindParams {
  return params.map((p) => {
    if (
      p === null ||
      typeof p === 'number' ||
      typeof p === 'string' ||
      p instanceof Uint8Array
    ) {
      return p;
    }
    if (typeof p === 'bigint') return Number(p);
    if (p === undefined) return null;
    throw new TypeError(
      `cannot bind value of type ${typeof p} (sql: ${sql.slice(0, 80)}…)`,
    );
  });
}

export function wrapSqlJsDatabase(raw: SqlJsDatabase): DB {
  // Matches openDatabase(): schema-level invariants must fire in the
  // playground too. (WAL is meaningless for an in-memory DB — skipped.)
  raw.run('PRAGMA foreign_keys = ON');

  // Transaction nesting depth — better-sqlite3 nests via savepoints.
  let txDepth = 0;

  function prepare(sql: string): Statement {
    const run = (...params: unknown[]): RunResult => {
      const stmt = raw.prepare(sql);
      try {
        stmt.run(toBindParams(sql, params));
      } finally {
        stmt.free();
      }
      // sqlite3_changes / last_insert_rowid are connection-global and
      // unaffected by the SELECT below (it modifies nothing).
      const changes = raw.getRowsModified();
      const idStmt = raw.prepare('SELECT last_insert_rowid() AS id');
      let lastInsertRowid = 0;
      try {
        idStmt.step();
        lastInsertRowid = Number(idStmt.getAsObject().id ?? 0);
      } finally {
        idStmt.free();
      }
      return { changes, lastInsertRowid };
    };

    const get = (...params: unknown[]): unknown => {
      const stmt = raw.prepare(sql);
      try {
        stmt.bind(toBindParams(sql, params));
        if (!stmt.step()) return undefined;
        return stmt.getAsObject();
      } finally {
        stmt.free();
      }
    };

    const all = (...params: unknown[]): unknown[] => {
      const stmt = raw.prepare(sql);
      try {
        stmt.bind(toBindParams(sql, params));
        const rows: unknown[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    };

    return { run, get, all };
  }

  const db: DB = {
    prepare,

    exec(sql: string): unknown {
      return raw.exec(sql);
    },

    pragma(source: string): unknown {
      // better-sqlite3 default shape: array of row objects.
      const results = raw.exec(`PRAGMA ${source}`);
      if (results.length === 0) return [];
      const { columns, values } = results[0];
      return values.map((row) =>
        Object.fromEntries(columns.map((c, i) => [c, row[i]])),
      );
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction<F extends (...args: any[]) => any>(fn: F): F {
      const wrapped = (...args: Parameters<F>): ReturnType<F> => {
        const savepoint = txDepth > 0 ? `calendrome_sp_${txDepth}` : null;
        raw.run(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN');
        txDepth++;
        try {
          const result = fn(...args);
          raw.run(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
          return result;
        } catch (err) {
          raw.run(
            savepoint
              ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`
              : 'ROLLBACK',
          );
          throw err;
        } finally {
          txDepth--;
        }
      };
      return wrapped as F;
    },

    close(): void {
      raw.close();
    },
  };

  return db;
}
