/**
 * MCP stdio server entry point.
 *
 * Boots once per process: opens the SQLite database, runs migrations,
 * builds the tool array, and wires `tools/list` + `tools/call` handlers
 * over the stdio transport. The MCP client (Claude, an editor, etc.)
 * speaks JSON-RPC; we route each `tools/call` to the matching handler
 * in `tools/index.ts` and serialize the result as a single text block.
 *
 * Runs alongside the GUI server (a separate Node process) — both share
 * the same SQLite file via WAL mode, so writes from MCP are visible to
 * the GUI on its next request.
 */
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

const DB_PATH = process.env.CALENDROME_DB ?? 'calendrome.db';

const server = new Server(
  { name: 'calendrome', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const db = openDatabase(DB_PATH);
migrate(db);

const calendar: CalendarClient =
  process.env.CALENDROME_CALENDAR === 'google'
    ? new GoogleCalendarClient()
    : new LocalCalendarClient();

const tools = buildTools(db, { calendar });
const toolsByName = new Map(tools.map((t) => [t.name, t]));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = toolsByName.get(name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
    };
  }
  try {
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
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
