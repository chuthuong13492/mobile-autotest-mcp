import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { TOOLS, toToolJsonSchemas } from '@autotest/core';
import { composeServer, TOOL_DESCRIPTIONS } from '@autotest/mcp-server';
import { dataRoot } from './helpers.ts';

const CATALOG = TOOLS.map((t) => t.name);
const quiet = { write: () => true };

async function inProcess(config?: string) {
  const composed = await composeServer({
    dataRoot: dataRoot(config),
    env: { AUTOTEST_LOG_LEVEL: 'error' },
    stderr: quiet,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await composed.server.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientT);
  return { composed, client };
}

afterEach(() => vi.restoreAllMocks());

describe('MCP-001 bootstrap (SDK client, in process)', () => {
  it('lists exactly the 18 catalog tools in catalog order with contract schemas, annotations and _meta hints', async () => {
    const { composed, client } = await inProcess();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(CATALOG);
    expect(tools).toHaveLength(18);
    const schemas = new Map(toToolJsonSchemas().map((s) => [s.name, s]));
    for (const t of tools) {
      const contract = TOOLS.find((c) => c.name === t.name)!;
      expect(t.description).toBe(TOOL_DESCRIPTIONS[contract.name]);
      expect(t.inputSchema).toEqual({ type: 'object', ...schemas.get(contract.name)!.inputSchema });
      expect(t.outputSchema).toEqual(schemas.get(contract.name)!.outputSchema);
      expect(t.annotations).toEqual(contract.annotations);
      expect(t._meta?.['anthropic/requiresUserInteraction'] === true).toBe(contract.requiresUserInteraction);
    }
    expect(tools.filter((t) => t._meta?.['anthropic/requiresUserInteraction']).map((t) => t.name)).toEqual([
      'request_approval',
      'publish_github_report',
    ]);
    const again = await client.listTools();
    expect(again.tools.map((t) => t.name)).toEqual(CATALOG);
    await client.close();
    await composed.close();
  });

  it('invalid input yields the contract E_VALIDATION tool error; stubs answer E_CAPABILITY_UNAVAILABLE', async () => {
    const { composed, client } = await inProcess();
    const bad = await client.callTool({ name: 'get_run_status', arguments: { runId: 42 } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({
      error: { code: 'E_VALIDATION', recoverable: true, details: { issues: [{ pointer: '/runId' }] } },
    });
    // Every tool is implemented since v1.1; the stub set still answers E_CAPABILITY_UNAVAILABLE for builds without one.
    const { notImplementedUseCases } = await import('../src/stubs.ts');
    const stub = await notImplementedUseCases().list_devices({ platform: 'all', includeUnavailable: false }, {
      toolCallId: 'call_01JCAAAAAAAAAAAAAAAAAAAAAA',
    } as never);
    expect(stub).toMatchObject({ ok: false, error: { error: { code: 'E_CAPABILITY_UNAVAILABLE' } } });
    const missing = await client.callTool({
      name: 'get_run_status',
      arguments: { runId: 'run_01JCAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(missing).toMatchObject({ isError: true, structuredContent: { error: { code: 'E_RUN_NOT_FOUND' } } });
    await client.close();
    await composed.close();
  });

  it('records config.loaded in the audit log when the user config is valid, and works without one', async () => {
    const withConfig = await inProcess('version: 1\n');
    expect(withConfig.composed.policy.ok).toBe(true);
    const events = await withConfig.composed.ports.audit.readAll();
    expect(events.map((e) => e.kind)).toEqual(['config.loaded']);
    await withConfig.client.close();
    await withConfig.composed.close();
    const without = await inProcess();
    expect(without.composed.policy.ok).toBe(false);
    expect((await without.client.listTools()).tools).toHaveLength(18);
    await without.client.close();
    await without.composed.close();
  });

  it('opens no network listener and writes only JSON-RPC frames to its stdout stream', async () => {
    const listen = vi.spyOn(net.Server.prototype, 'listen');
    const createServer = vi.spyOn(http, 'createServer');
    const stdoutSpy = vi.spyOn(process.stdout, 'write');
    const composed = await composeServer({
      dataRoot: dataRoot('version: 1\n'),
      env: { AUTOTEST_LOG_LEVEL: 'debug' },
      stderr: quiet,
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames: string[] = [];
    stdout.on('data', (b: Buffer) => frames.push(...b.toString('utf8').split('\n').filter(Boolean)));
    await composed.server.connect(new StdioServerTransport(stdin, stdout));
    const send = (m: object) => stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_devices', arguments: {} } });
    for (let i = 0; i < 100 && frames.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    await composed.close();
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const f of frames) expect(JSON.parse(f)).toMatchObject({ jsonrpc: '2.0' });
    expect(listen).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('the app source imports no network-serving modules', () => {
    const dir = path.resolve(import.meta.dirname, '../src');
    const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile());
    expect(files.length).toBeGreaterThan(5);
    for (const d of files) {
      const f = path.relative(dir, path.join(d.parentPath, d.name));
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(text, f).not.toMatch(
        /from 'node:(net|http|https|http2|dgram|tls)'|from '(net|http|https|http2|dgram|tls)'/,
      );
    }
  });

  it('descriptions equal the Purpose lines of the tool contracts (docs-sync)', () => {
    const doc = fs.readFileSync(path.resolve(import.meta.dirname, '../../../docs/mcp-tool-contracts.md'), 'utf8');
    for (const t of TOOLS) {
      const at = doc.indexOf(`### ${t.id} ${t.name}`);
      const purpose = /- \*\*Purpose:\*\* (.+)\n/.exec(doc.slice(at))?.[1];
      expect(TOOL_DESCRIPTIONS[t.name], t.name).toBe(purpose);
    }
  });
});

describe('MCP-001 bootstrap (real stdio process)', () => {
  it('serves 18 tools over stdio with protocol-only stdout and exits when the client closes', async () => {
    const root = dataRoot('version: 1\n');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(import.meta.dirname, '../src/main.ts')],
      env: { PATH: '/usr/bin:/bin', HOME: path.dirname(root), AUTOTEST_HOME: root, AUTOTEST_LOG_LEVEL: 'info' },
      stderr: 'pipe',
    });
    const stderr: string[] = [];
    transport.stderr?.on('data', (b: Buffer) => stderr.push(b.toString('utf8')));
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    const errors: Error[] = [];
    client.onerror = (e) => errors.push(e);
    await client.connect(transport);
    const pid = transport.pid!;
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(CATALOG);
    const r = await client.callTool({ name: 'list_devices', arguments: {} });
    expect(r.structuredContent).toBeDefined();
    await client.close();
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(() => process.kill(pid, 0)).toThrow();
    expect(errors).toEqual([]);
    const lines = stderr
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { msg: string });
    expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining(['config.loaded', 'server.started']));
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  }, 60_000);
});
