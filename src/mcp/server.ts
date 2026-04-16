import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { buildTools } from './tools/index.js';

const DB_PATH = process.env.CALENDROME_DB ?? 'calendrome.db';

const server = new McpServer({
  name: 'calendrome',
  version: '0.1.0',
});

const db = openDatabase(DB_PATH);
migrate(db);

const tools = buildTools(db);
for (const t of tools) {
  server.tool(
    t.name,
    t.description,
    t.inputSchema,
    async (args: Record<string, unknown>) => {
      const result = await t.handler(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
