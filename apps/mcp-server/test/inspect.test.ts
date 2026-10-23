import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExampleAdapter } from '@autotest/adapter-sdk/testing';
import { composeServer, createProbePort } from '@autotest/mcp-server';
import { loadPolicyConfig } from '@autotest/policy';

const quiet = { write: () => true };

function setup(files: string[], opts: { config?: boolean } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-ins-')));
  const ws = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  for (const f of ['example.json', ...files]) {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), '');
  }
  fs.mkdirSync(path.join(outside), { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret_test.dart'), '');
  fs.mkdirSync(path.join(ws, 'test'), { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'test', 'linked'));
  fs.mkdirSync(path.join(ws, 'node_modules/pkg/test'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'node_modules/pkg/test/dep_test.dart'), '');
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  if (opts.config !== false)
    fs.writeFileSync(path.join(data, 'config.yaml'), `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\n`);
  return { base, ws, data };
}

async function compose(data: string) {
  return composeServer({
    dataRoot: data,
    env: { AUTOTEST_LOG_LEVEL: 'error' },
    stderr: quiet,
    adapters: [createExampleAdapter()],
  });
}

describe('INS-001 inspect_project (through the tool pipeline)', () => {
  it('inspects an allowlisted workspace by id or by path and persists the profile', async () => {
    const { ws, data } = setup(['lib/main.dart', 'test/a_test.dart']);
    const c = await compose(data);
    const r = await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as {
      projectProfileId: string;
      frameworks: { adapterId: string }[];
      languages: string[];
      platforms: { status: string; evidence: string[] }[];
    };
    expect(out.frameworks.map((f) => f.adapterId)).toEqual(['example']);
    expect(out.languages).toEqual(['dart']);
    for (const p of out.platforms) if (p.status === 'present') expect(p.evidence.length).toBeGreaterThan(0);
    const profile = await c.ports.profiles.get(out.projectProfileId);
    expect(profile?.workspace).toEqual({ rootRealPath: ws, allowlistEntryId: 'ws_app' });
    const byPath = await c.call('inspect_project', { workspace: ws, probeToolchains: false });
    const second = byPath.structuredContent as typeof out;
    expect(second.projectProfileId).not.toBe(out.projectProfileId);
    expect({ ...second, projectProfileId: '' }).toEqual({ ...out, projectProfileId: '' });
    await c.close();
  });

  it('refuses non-allowlisted workspaces, unknown adapters and a missing policy', async () => {
    const { base, data } = setup([]);
    const c = await compose(data);
    expect((await c.call('inspect_project', { workspace: 'ws_other' })).structuredContent).toMatchObject({
      error: { code: 'E_WORKSPACE_NOT_ALLOWED' },
    });
    expect(
      (await c.call('inspect_project', { workspace: path.join(base, 'outside') })).structuredContent,
    ).toMatchObject({ error: { code: 'E_WORKSPACE_NOT_ALLOWED' } });
    expect(
      (await c.call('inspect_project', { workspace: 'ws_app', adapters: ['flutter'] })).structuredContent,
    ).toMatchObject({ error: { code: 'E_VALIDATION' } });
    await c.close();
    const none = setup([], { config: false });
    const c2 = await compose(none.data);
    expect((await c2.call('inspect_project', { workspace: 'ws_app' })).structuredContent).toMatchObject({
      error: { code: 'E_POLICY_UNAVAILABLE' },
    });
    await c2.close();
  });
});

describe('INS-002 inspect_test_inventory (through the tool pipeline)', () => {
  it('snapshots an Autotrader-scale inventory (775 files) and pages it without duplicates or gaps', async () => {
    const files = Array.from(
      { length: 775 },
      (_, i) => `test/${i % 7 ? 'unit' : 'widget'}/t${String(i).padStart(3, '0')}_test.dart`,
    );
    const weird = ['test/$(touch pwned)_test.dart', 'test/a;b|c_test.dart'];
    const { ws, data } = setup([...files, ...weird]);
    const c = await compose(data);
    const profileId = (
      (await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false })).structuredContent as {
        projectProfileId: string;
      }
    ).projectProfileId;
    const first = (await c.call('inspect_test_inventory', { projectProfileId: profileId, limit: 200 }))
      .structuredContent as {
      inventoryId: string;
      counts: { total: number };
      completeness: { complete: boolean };
      targets: { id: string; path: string }[];
      nextCursor: string | null;
      untrustedFields: string[];
    };
    expect(first.counts.total).toBe(777);
    expect(first.completeness.complete).toBe(true);
    expect(first.untrustedFields).toEqual(['/targets/*/path']);
    const paths = first.targets.map((t) => t.path);
    let cursor = first.nextCursor;
    let pages = 1;
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(20_000);
    while (cursor) {
      const p = (
        await c.call('inspect_test_inventory', {
          projectProfileId: profileId,
          inventoryId: first.inventoryId,
          cursor,
          limit: 200,
        })
      ).structuredContent as typeof first;
      // A 200-target page exceeds the 20,000-character cap, so pages shrink to fit (truncated + cursor).
      expect(JSON.stringify(p).length).toBeLessThanOrEqual(20_000);
      paths.push(...p.targets.map((t) => t.path));
      cursor = p.nextCursor;
      pages++;
    }
    expect(pages).toBeGreaterThanOrEqual(4);
    expect(new Set(paths).size).toBe(777);
    expect(paths).toEqual(expect.arrayContaining(weird));
    expect(paths.some((p) => p.includes('linked') || p.includes('node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'pwned'))).toBe(false);
    expect((await c.ports.inventories.get(first.inventoryId))?.targets).toHaveLength(777);
    await c.close();
  });

  it('serves pages from an existing snapshot and maps lookup and prefix errors', async () => {
    const { data } = setup(['test/a_test.dart', 'test/b_test.dart']);
    const c = await compose(data);
    const profileId = (
      (await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false })).structuredContent as {
        projectProfileId: string;
      }
    ).projectProfileId;
    const snap = (await c.call('inspect_test_inventory', { projectProfileId: profileId })).structuredContent as {
      inventoryId: string;
      targets: unknown[];
    };
    const again = (
      await c.call('inspect_test_inventory', { projectProfileId: profileId, inventoryId: snap.inventoryId })
    ).structuredContent as typeof snap;
    expect(again).toEqual(snap);
    expect(
      (await c.call('inspect_test_inventory', { projectProfileId: 'prj_01JC0000000000000000000000' }))
        .structuredContent,
    ).toMatchObject({ error: { code: 'E_NOT_FOUND' } });
    const other = (
      (await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false })).structuredContent as {
        projectProfileId: string;
      }
    ).projectProfileId;
    expect(
      (await c.call('inspect_test_inventory', { projectProfileId: other, inventoryId: snap.inventoryId }))
        .structuredContent,
    ).toMatchObject({ error: { code: 'E_NOT_FOUND' } });
    expect(
      (
        await c.call('inspect_test_inventory', {
          projectProfileId: profileId,
          inventoryId: snap.inventoryId,
          filter: { pathPrefix: '../' },
        })
      ).structuredContent,
    ).toMatchObject({ error: { code: 'E_PATH_ESCAPE' } });
    const events = await c.ports.audit.readAll();
    expect(events.filter((e) => e.kind === 'tool.result').every((e) => typeof e.data['result'] === 'string')).toBe(
      true,
    );
    await c.close();
  });
});

describe('INS-001 toolchain probes', () => {
  function probeEnv(script: string) {
    const { base, ws, data } = setup([]);
    const flutter = path.join(base, 'flutter');
    fs.writeFileSync(flutter, script, { mode: 0o755 });
    const policy = loadPolicyConfig(
      `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables: { flutter: { path: ${flutter} } }\n`,
    );
    if (!policy.ok) throw new Error('policy');
    return { config: policy.policy.config, data, ws };
  }

  it('runs the allowlisted version probe and reports unsupported kinds without running anything', async () => {
    const e = probeEnv(
      '#!/bin/sh\n[ "$1" = "--version" ] && [ "$2" = "--machine" ] && echo \'{"frameworkVersion":"3.38.4","dartSdkVersion":"3.10.3"}\'\n',
    );
    const port = createProbePort({ config: e.config, dataRoot: e.data, workspaceRoot: e.ws, workspaceId: 'ws_app' });
    const r = await port.probe('flutter_version');
    expect(r).toMatchObject({ available: true, exitCode: 0 });
    expect(r.available && JSON.parse(r.stdout)).toEqual({ frameworkVersion: '3.38.4', dartSdkVersion: '3.10.3' });
    expect(await port.probe('xcode_version')).toEqual({ available: false, reason: 'no_probe_schema' });
    expect(fs.readdirSync(path.join(e.data, 'tmp', 'probes'))).toEqual([]);
  });

  it('enforces the probe timeout and reports a missing executable', async () => {
    const e = probeEnv('#!/bin/sh\n/bin/sleep 30\n');
    const port = createProbePort({
      config: e.config,
      dataRoot: e.data,
      workspaceRoot: e.ws,
      workspaceId: 'ws_app',
      timeoutMs: 300,
    });
    const t0 = Date.now();
    expect(await port.probe('flutter_version')).toEqual({ available: false, reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(5000);
    const none = createProbePort({
      config: { ...e.config, executables: {} },
      dataRoot: e.data,
      workspaceRoot: e.ws,
      workspaceId: 'ws_app',
    });
    expect(await none.probe('flutter_version')).toEqual({ available: false, reason: 'executable_not_allowlisted' });
  });
});
