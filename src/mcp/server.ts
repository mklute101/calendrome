/**
 * MCP stdio server entry point.
 *
 * Boots once per process: runs migrations, captures the tool metadata
 * for `tools/list`, and wires `tools/list` + `tools/call` handlers over
 * the stdio transport. The MCP client (Claude, an editor, etc.) speaks
 * JSON-RPC; we route each `tools/call` to the matching handler in
 * `tools/index.ts` and serialize the result as a single text block.
 *
 * Runs alongside the GUI server (a separate Node process) — both share
 * the same SQLite file via WAL mode. Each `tools/call` opens a fresh
 * connection (mirroring the GUI's per-request pattern) rather than
 * reusing a boot-time one: a long-lived connection can serve a stale
 * view of the file — a pinned WAL read snapshot, or, if the DB file is
 * ever atomically replaced (backup/restore), an old inode that `lsof`
 * still shows under the same path. Either way concurrent sessions
 * drift apart until restart (#90). Opening per call costs well under a
 * millisecond against human-frequency tool calls.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import {
  GoogleCalendarClient,
  LocalCalendarClient,
  type CalendarClient,
} from '../calendar/index.js';
import { buildTools } from './tools/index.js';
import { callTool } from './call-tool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Absolute always, mirroring src/gui/server.ts: a cwd-relative
// default silently opens a different empty DB depending on who
// spawned the process (#132). Compiled file lives at dist/src/mcp,
// so ../../.. is the repo root.
const DB_PATH = resolve(
  process.env.CALENDROME_DB ?? join(__dirname, '..', '..', '..', 'calendrome.db'),
);

const server = new Server(
  { name: 'calendrome', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const calendar: CalendarClient =
  process.env.CALENDROME_CALENDAR === 'google'
    ? new GoogleCalendarClient()
    : new LocalCalendarClient();

// Migrate once at startup, then close — tool calls open their own
// connections. Tool names/schemas are static, so capture them from
// the boot connection's tool array before it goes away.
const bootDb = openDatabase(DB_PATH);
migrate(bootDb);
const toolMeta = buildTools(bootDb, { calendar }).map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));
bootDb.close();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolMeta,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return callTool(DB_PATH, calendar, name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
