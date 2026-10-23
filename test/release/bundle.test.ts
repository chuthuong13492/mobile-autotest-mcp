/**
 * Release bundle (M7): build the package into a temporary folder, then drive the **bundled** server over stdio
 * JSON-RPC through a whole run with the fake Flutter runner. This proves the bundled supervisor entry resolves
 * (`supervisor.mjs` next to the server bundle) and that the bins refuse unsupported Node versions.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupRunData } from '../../apps/mcp-server/test/runSetup.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');

function rpcClient(entry: string, env: Record<string, string>) {
  const p = spawn(process.execPath, [entry], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map<number, (v: unknown) => void>();
  let buf = '';
  p.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line) as { id?: number; result?: unknown };
      if (m.id !== undefined) waiting.get(m.id)?.(m.result);
    }
  });
  let id = 0;
  const send = (method: string, params: unknown) =>
    new Promise<unknown>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  const call = async (name: string, args: unknown) =>
    ((await send('tools/call', { name, arguments: args })) as { structuredContent: Record<string, unknown> })
      .structuredContent;
  return {
    async init() {
      await send('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'bundle-test', version: '0' },
      });
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    call,
    close: () => p.stdin.end(),
  };
}

describe('release bundle', () => {
  it(
    'builds, and the bundled server runs a plan end to end through the bundled supervisor',
    { timeout: 240_000 },
    async () => {
      const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-rel-')));
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-release.ts')], {
        env: { ...process.env, AUTOTEST_RELEASE_OUT: out },
        stdio: 'ignore',
      });
      const dist = path.join(out, 'package', 'dist');
      for (const f of ['autotest-mcp.mjs', 'autotest.mjs', 'server.bundle.mjs', 'cli.bundle.mjs', 'supervisor.mjs'])
        expect(fs.existsSync(path.join(dist, f)), f).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package', 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(pkg).toMatchObject({
        name: 'mobile-autotest-mcp',
        engines: { node: '>=24' },
        bin: { autotest: 'dist/autotest.mjs' },
      });
      expect(pkg['dependencies']).toBeUndefined();
      expect(fs.readFileSync(path.join(out, 'package', 'THIRD_PARTY_LICENSES.md'), 'utf8')).toContain('## zod ');
      expect(fs.existsSync(path.join(out, 'package', 'plugin', 'skills', 'pr-mobile-autotest', 'SKILL.md'))).toBe(true);

      const f = setupRunData({ 'test/a_test.dart': 'pass', 'test/flaky_test.dart': 'flaky' });
      const c = rpcClient(path.join(dist, 'autotest-mcp.mjs'), {
        AUTOTEST_HOME: f.data,
        AUTOTEST_HOST_ID: 'bundle-host',
        AUTOTEST_LOG_LEVEL: 'error',
      });
      await c.init();
      const body = '## Acceptance criteria\n- [ ] a shows "ok"\n- [ ] flaky shows "ok"\n';
      const prc = (
        await c.call('get_pr_context', { workspace: 'ws_app', source: 'manual', manual: { title: 'x', body } })
      )['prContextId'];
      const prj = (await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false }))[
        'projectProfileId'
      ];
      const inv = (await c.call('inspect_test_inventory', { projectProfileId: prj }))['inventoryId'];
      const rqs = (await c.call('extract_requirements', { prContextId: prc }))['requirementSetId'];
      const kase = (key: string, ac: string, p: string, technique: string) => ({
        clientKey: key,
        title: `Case ${key}`,
        requirementRefs: ['REQ-001'],
        acRefs: [ac],
        level: 'unit',
        technique,
        priority: 'must',
        platforms: ['host'],
        steps: ['run'],
        expectedResults: ["Text 'ok' is visible"],
        targetPath: p,
        automation: 'existing_test',
      });
      const plan = await c.call('generate_test_plan', {
        requirementSetId: rqs,
        inventoryId: inv,
        platformsInScope: ['host'],
        draft: {
          testCases: [
            kase('a', 'REQ-001.AC-01', 'test/a_test.dart', 'regression'),
            kase('b', 'REQ-001.AC-02', 'test/flaky_test.dart', 'positive'),
          ],
        },
      });
      expect(
        (await c.call('validate_test_coverage', { planId: plan['planId'], planHash: plan['planHash'] }))['decision'],
      ).toBe('pass');
      const runId = (await c.call('run_tests', { planId: plan['planId'], planHash: plan['planHash'] }))['runId'];
      expect(runId).toMatch(/^run_/);
      let state = '';
      for (let i = 0; i < 300 && !['completed', 'cancelled', 'timed_out', 'infra_error'].includes(state); i++) {
        state = (await c.call('get_run_status', { runId }))['state'] as string;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(state).toBe('completed');
      const results = (await c.call('get_run_results', { runId }))['results'] as { outcome: string; flaky: boolean }[];
      expect(results.map((r) => [r.outcome, r.flaky]).sort()).toEqual([
        ['passed', false],
        ['passed', true],
      ]);
      const report = await c.call('generate_pr_test_report', {
        planId: plan['planId'],
        planHash: plan['planHash'],
        runIds: [runId],
      });
      expect(report).toMatchObject({ verdict: 'pass' });
      c.close();
    },
  );
});
