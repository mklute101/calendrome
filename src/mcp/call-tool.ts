/**
 * Per-call tool dispatch for the MCP server.
 *
 * Each call opens a fresh SQLite connection, resolves the tool by
 * name, runs its handler, and closes the connection — mirroring the
 * GUI server's connection-per-request pattern. A long-lived boot-time
 * connection can serve a stale view of the shared DB file: a pinned
 * WAL read snapshot, or — if the file is ever atomically replaced by
 * a backup/restore — an old inode that still answers under the same
 * path. Either way, concurrent MCP sessions drift out of sync until
 * restart (#90). `buildTools` is a pure closure factory, so
 * rebuilding the descriptor array per call costs microseconds.
 */
import { openDatabase } from '../db/connection.js';
import type { CalendarClient } from '../calendar/index.js';
import { buildTools } from './tools/index.js';

export interface CallToolResult {
  // Index signature keeps this assignable to the MCP SDK's ServerResult.
  [key: string]: unknown;
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}

export async function callTool(
  dbPath: string,
  calendar: CalendarClient,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const db = openDatabase(dbPath);
  try {
    const tool = buildTools(db, { calendar }).find((t) => t.name === name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
      };
    }
    const result = await tool.handler(args ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
    };
  } finally {
    db.close();
  }
}
