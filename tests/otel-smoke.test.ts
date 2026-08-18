import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Protocol-integrity smoke test for the OTel bootstrap (#162).
 *
 * Spawns the BUILT MCP server (stdout is the JSON-RPC transport) and
 * runs an initialize + tools/list + tools/call exchange, both with
 * CALENDROME_OTEL=1 (and no backend listening, so the exporter fails)
 * and with the flag unset. In both cases every stdout line must be a
 * valid JSON-RPC frame — exporter connection failures must land on
 * stderr and must not crash the server.
 *
 * Skipped when dist/ is absent: run `npm run build` first.
 */
const SERVER = join(process.cwd(), 'dist', 'src', 'mcp', 'server.js');

interface ExchangeResult {
  stdoutLines: string[];
  stderr: string;
  exitCode: number | null;
}

async function runExchange(
  otel: boolean,
  endpoint?: string,
): Promise<ExchangeResult> {
  const dbDir = mkdtempSync(join(tmpdir(), 'calendrome-otel-smoke-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CALENDROME_DB: join(dbDir, 'smoke.db'),
  };
  delete env.CALENDROME_OTEL;
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otel) {
    env.CALENDROME_OTEL = '1';
    // Default: point at a port where nothing listens so export
    // always fails. Tests that assert on exported spans pass a live
    // capture endpoint instead.
    env.OTEL_EXPORTER_OTLP_ENDPOINT =
      endpoint ?? 'http://127.0.0.1:49151';
  }

  const child = spawn(process.execPath, [SERVER], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

  const frames = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'otel-smoke', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} },
    },
  ];
  for (const frame of frames) {
    child.stdin.write(JSON.stringify(frame) + '\n');
  }

  // Wait until the response to id 3 shows up, then close stdin so the
  // server shuts down the way a real client disconnect does.
  await waitFor(() => stdout.includes('"id":3'), 20_000, child);
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 20_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  rmSync(dbDir, { recursive: true, force: true });
  return {
    stdoutLines: stdout.split('\n').filter((l) => l.trim() !== ''),
    stderr,
    exitCode,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    if (Date.now() - start > timeoutMs) {
      child.kill('SIGKILL');
      throw new Error('timed out waiting for JSON-RPC response');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function assertOnlyJsonRpc(lines: string[]): void {
  expect(lines.length).toBeGreaterThanOrEqual(3);
  for (const line of lines) {
    const parsed = JSON.parse(line) as { jsonrpc?: string };
    expect(parsed.jsonrpc).toBe('2.0');
  }
}

describe.skipIf(!existsSync(SERVER))('MCP protocol integrity', () => {
  it(
    'stdout carries only JSON-RPC frames with CALENDROME_OTEL=1 and no backend',
    { timeout: 60_000 },
    async () => {
      const result = await runExchange(true);
      assertOnlyJsonRpc(result.stdoutLines);
      const toolsList = result.stdoutLines
        .map((l) => JSON.parse(l) as { id?: number; result?: { tools?: unknown[] } })
        .find((f) => f.id === 2);
      expect(toolsList?.result?.tools?.length).toBeGreaterThan(0);
      // Exporter failure must not crash the server; it exits cleanly
      // after stdin closes even while flushing spans it cannot send.
      expect(result.exitCode).toBe(0);
    },
  );

  it(
    'exports spans over OTLP and flushes them before exit',
    { timeout: 60_000 },
    async () => {
      // Local OTLP sink capturing POST bodies. The exporter from
      // @opentelemetry/exporter-trace-otlp-http sends JSON, so the
      // captured body can be searched as a string. This is the test
      // that fails if the bootstrap loses the module-evaluation race
      // (SDK started after the CJS graph loaded -> nothing patched,
      // no spans, empty flush) or if shutdown flushing breaks.
      const bodies: string[] = [];
      const sink: Server = createServer((req, res) => {
        let body = '';
        req.on('data', (d: Buffer) => (body += d.toString()));
        req.on('end', () => {
          if (req.url?.startsWith('/v1/traces')) bodies.push(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        });
      });
      await new Promise<void>((resolve) =>
        sink.listen(0, '127.0.0.1', resolve),
      );
      const address = sink.address();
      if (address === null || typeof address === 'string') {
        throw new Error('sink did not bind to a port');
      }

      try {
        const result = await runExchange(
          true,
          `http://127.0.0.1:${address.port}`,
        );
        assertOnlyJsonRpc(result.stdoutLines);
        expect(result.exitCode).toBe(0);
        // The shutdown flush must have delivered spans before the
        // process exited -- a short-lived MCP session's spans survive.
        const exported = bodies.join('\n');
        expect(exported).toContain('calendrome-mcp');
        expect(exported).toContain('process.start');
      } finally {
        sink.close();
      }
    },
  );

  it(
    'stdout carries only JSON-RPC frames with the flag unset',
    { timeout: 60_000 },
    async () => {
      const result = await runExchange(false);
      assertOnlyJsonRpc(result.stdoutLines);
      expect(result.exitCode).toBe(0);
      // Default path: no OTel diagnostics at all.
      expect(result.stderr).not.toContain('[otel');
    },
  );
});
