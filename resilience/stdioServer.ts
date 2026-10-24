/**
 * A real `autotest-mcp` process over stdio for fault injection (OPS-006): JSON-RPC client, the process handle for
 * `kill -9`, and stdin close (client disconnect).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const MAIN = path.resolve(import.meta.dirname, '../apps/mcp-server/src/main.ts');

export interface StdioServer {
  readonly proc: ChildProcess;
  call<T>(name: string, args: Record<string, unknown>): Promise<T>;
  /** The raw tool result (for error checks). */
  raw(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; structuredContent: Record<string, unknown> }>;
  exited: Promise<number | null>;
}

export async function startServer(dataRoot: string, env: Record<string, string>): Promise<StdioServer> {
  const proc = spawn(process.execPath, [MAIN], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...env, AUTOTEST_HOME: dataRoot, AUTOTEST_LOG_LEVEL: 'error' },
  });
  const exited = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
  const waiting = new Map<number, (v: unknown) => void>();
  let buf = '';
  let id = 0;
  proc.stdout!.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i)) as { id?: number; result?: unknown; error?: unknown };
      buf = buf.slice(i + 1);
      if (m.id) waiting.get(m.id)?.(m.result ?? m.error);
    }
  });
  const send = (method: string, params: unknown) =>
    new Promise<unknown>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  await send('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'resilience', version: '0' },
  });
  proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const raw = async (name: string, args: Record<string, unknown>) =>
    (await send('tools/call', { name, arguments: args })) as {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
    };
  return {
    proc,
    exited,
    raw,
    async call<T>(name: string, args: Record<string, unknown>) {
      const r = await raw(name, args);
      if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.structuredContent)}`);
      return r.structuredContent as T;
    },
  };
}
