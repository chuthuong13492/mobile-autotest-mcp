import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Run } from '@autotest/core';
import { openCli, run, suggestFlutter } from '@autotest/cli';
import { nodeExecPort } from '@autotest/exec';
import { openDataRoot } from '@autotest/storage';
import { io } from './fixtures.ts';

function home(opts: { config?: (ws: string, flutter: string) => string; resolved?: boolean } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-doc-')));
  const ws = path.join(base, 'app');
  fs.mkdirSync(path.join(ws, 'test'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'pubspec.yaml'), 'name: app\n');
  if (opts.resolved !== false) {
    fs.mkdirSync(path.join(ws, '.dart_tool'));
    fs.writeFileSync(path.join(ws, '.dart_tool', 'package_config.json'), '{}');
  }
  const sdk = path.join(base, 'sdk');
  fs.mkdirSync(path.join(sdk, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'bin', 'flutter'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(sdk, 'version'), '3.47.1\n');
  const data = path.join(base, '.autotest');
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    opts.config?.(ws, path.join(sdk, 'bin', 'flutter')) ??
      `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables: { flutter: { path: ${path.join(sdk, 'bin', 'flutter')} } }\n`,
    { mode: 0o600 },
  );
  return {
    base,
    ws,
    data,
    sdk,
    env: { env: { HOME: base, AUTOTEST_HOME: data, AUTOTEST_HOST_ID: 'test-host', PATH: '/usr/bin:/bin' } },
  };
}

async function doctorLines(env: { env: Record<string, string> }, flags: string[] = []) {
  const t = io(false);
  const code = await run(['doctor', ...flags], t.value, env);
  return { code, text: t.out.join('\n'), fails: t.out.filter((l) => l.startsWith('FAIL')) };
}

describe('CLI-002 doctor', () => {
  it('a healthy setup has no FAIL; Claude Code registration, Skill and deny rules are reported', async () => {
    const h = home();
    let d = await doctorLines(h.env);
    expect(d.fails).toEqual([]);
    expect(d.code).toBe(0);
    expect(d.text).toMatch(/PASS {2}node/);
    expect(d.text).toMatch(/PASS {2}executables\s+flutter → /);
    expect(d.text).toMatch(/WARN {2}claude-code/);
    fs.writeFileSync(
      path.join(h.base, '.claude.json'),
      JSON.stringify({ mcpServers: { autotest: { command: 'node' } } }),
    );
    fs.mkdirSync(path.join(h.base, '.claude', 'skills', 'pr-mobile-autotest'), { recursive: true });
    fs.writeFileSync(path.join(h.base, '.claude', 'skills', 'pr-mobile-autotest', 'SKILL.md'), '---\n');
    fs.writeFileSync(
      path.join(h.base, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(autotest approve*)'] } }),
    );
    d = await doctorLines(h.env);
    expect(d.text).toMatch(/PASS {2}claude-code/);
    expect(d.text).toMatch(/PASS {2}skill/);
    expect(d.text).toMatch(/PASS {2}deny-rules/);
  });

  it('detects each documented failure mode and prints a remediation', async () => {
    const missing = home();
    fs.rmSync(missing.data, { recursive: true });
    expect((await doctorLines(missing.env)).text).toMatch(/FAIL {2}data-root.*\n.*autotest init/);

    const loose = home();
    fs.chmodSync(loose.data, 0o755);
    expect((await doctorLines(loose.env)).fails.join()).toMatch(/data-root/);

    const invalid = home({ config: () => 'version: 1\nworkspaces: nope\n' });
    expect((await doctorLines(invalid.env)).text).toMatch(/FAIL {2}config[\s\S]*E_POLICY_UNAVAILABLE/);

    const gone = home({
      config: (ws) =>
        `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables: { flutter: { path: /nonexistent/flutter } }\n`,
    });
    expect((await doctorLines(gone.env)).text).toMatch(
      /FAIL {2}executables\s+flutter: missing[\s\S]*suggest-executables/,
    );

    const pinned = home({
      config: (ws, fl) =>
        `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables: { flutter: { path: ${fl}, sha256: "sha256:${'0'.repeat(64)}" } }\n`,
    });
    expect((await doctorLines(pinned.env)).text).toMatch(/FAIL {2}executables\s+flutter: hash mismatch/);

    const noWs = home({
      config: (_ws, fl) =>
        `version: 1\nworkspaces: [{ id: ws_gone, path: /nonexistent/app }]\nexecutables: { flutter: { path: ${fl} } }\n`,
    });
    expect((await doctorLines(noWs.env)).fails.join()).toMatch(/ws_gone/);

    const unresolved = home({ resolved: false });
    const u = await doctorLines(unresolved.env);
    expect(u.code).toBe(0);
    expect(u.text).toMatch(/WARN {2}dependencies[\s\S]*flutter pub get/);
  });

  it('verifies the audit chain and flags tampering; flags runs whose supervisor is gone', async () => {
    const h = home();
    const ctx = openCli(h.env);
    await ctx.ports.audit.append({
      ts: '2026-10-23T10:00:00Z',
      actor: 'cli',
      kind: 'approval.revoked',
      subjectRefs: [],
      data: { approvalId: 'appr_01JC0000000000000000000001' },
    });
    await ctx.ports.runs.create(
      sampleRun('run_01JC000000000000000000000B', {
        state: 'running',
        statusCategory: 'running',
        supervisor: { pid: 2 ** 22 - 1, pgid: 2 ** 22 - 1, startTime: 'Thu Jan  1 00:00:00 2026' },
      }),
    );
    ctx.close();
    expect((await doctorLines(h.env, ['--audit'])).code).toBe(0);
    expect((await doctorLines(h.env)).text).toMatch(
      /WARN {2}runs\s+run_01JC000000000000000000000B is running but its supervisor is gone/,
    );
    const file = path.join(h.data, 'audit', fs.readdirSync(path.join(h.data, 'audit'))[0]!);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('appr_01JC0000000000000000000001', 'appr_01JC0000000000000000000002'),
    );
    const tampered = await doctorLines(h.env, ['--audit']);
    expect(tampered).toMatchObject({ code: 1 });
    expect(tampered.text).toMatch(/FAIL {2}audit-chain {2}hash_mismatch/);
  });

  it('--suggest-executables lists SDKs from PATH and FVM with their versions, without writing anything', async () => {
    const h = home();
    const fvm = path.join(h.base, 'fvm', 'versions', '3.38.4', 'bin');
    fs.mkdirSync(fvm, { recursive: true });
    fs.writeFileSync(path.join(fvm, 'flutter'), '#!/bin/sh\n', { mode: 0o755 });
    // Current SDKs record their version in bin/cache/flutter.version.json.
    fs.mkdirSync(path.join(fvm, 'cache'));
    fs.writeFileSync(path.join(fvm, 'cache', 'flutter.version.json'), JSON.stringify({ frameworkVersion: '3.38.4' }));
    const env = { ...h.env.env, PATH: `${path.join(h.sdk, 'bin')}:/usr/bin` };
    expect(suggestFlutter(env)).toEqual([
      { path: path.join(h.sdk, 'bin', 'flutter'), version: '3.47.1' },
      { path: path.join(fvm, 'flutter'), version: '3.38.4' },
    ]);
    const before = fs.readFileSync(path.join(h.data, 'config.yaml'), 'utf8');
    const d = await doctorLines({ env }, ['--suggest-executables']);
    expect(d.code).toBe(0);
    expect(d.text).toContain(`flutter: { path: ${path.join(fvm, 'flutter')} }   # 3.38.4`);
    expect(fs.readFileSync(path.join(h.data, 'config.yaml'), 'utf8')).toBe(before);
  });
});

function sampleRun(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    schemaVersion: 1,
    planId: 'plan_01JC0000000000000000000001',
    planHash: `v1:sha256:${'a'.repeat(64)}`,
    targets: ['TT-flutter-aaaaaaaaaaaa'],
    environment: 'local:test-host',
    devices: [],
    state: 'queued',
    statusCategory: 'pending',
    requestDigest: `sha256:${'b'.repeat(64)}`,
    authorizationIds: ['authz_01JC0000000000000000000001'],
    timeouts: { runMs: 60_000, attemptMs: 60_000, targetMs: 60_000 },
    retryPolicy: { maxAttempts: 1, retryOn: [] },
    counts: {},
    partial: false,
    limitations: [],
    createdAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

describe('CLI-003 cleanup', () => {
  it('the dry run lists exactly what a real cleanup removes; active runs and their files are kept; queued runs stay queued', async () => {
    const h = home();
    const old = 'run_01JC000000000000000000000C';
    const active = 'run_01JC000000000000000000000D';
    const lost = 'run_01JC000000000000000000000E';
    const queued = 'run_01JC000000000000000000000F';
    const { sql, stores } = openDataRoot(h.data);
    await stores.runs.create(
      sampleRun(old, { state: 'completed', statusCategory: 'completed', endedAt: '2026-01-01T00:00:00Z' }),
    );
    // "active": a live, identity-verified supervisor (this test process itself).
    const me = nodeExecPort().processInfo(process.pid)!;
    await stores.runs.create(
      sampleRun(active, {
        state: 'running',
        statusCategory: 'running',
        supervisor: { pid: me.pid, pgid: me.pgid, startTime: me.startTime },
      }),
    );
    await stores.runs.create(
      sampleRun(lost, {
        state: 'running',
        statusCategory: 'running',
        supervisor: { pid: 2 ** 22 - 1, pgid: 2 ** 22 - 1, startTime: 'Thu Jan  1 00:00:00 2026' },
      }),
    );
    await stores.runs.create(sampleRun(queued));
    sql.close();
    for (const id of [old, active]) {
      for (const f of ['attempts/1/stdout-0.log', 'artifacts/art_x', 'run.json']) {
        fs.mkdirSync(path.dirname(path.join(h.data, 'runs', id, f)), { recursive: true });
        fs.writeFileSync(path.join(h.data, 'runs', id, f), 'data');
      }
      fs.mkdirSync(path.join(h.data, 'tmp', id, 'home'), { recursive: true });
      const past = new Date('2026-01-01T00:00:00Z');
      fs.utimesSync(path.join(h.data, 'tmp', id), past, past);
    }
    const dry = io(false);
    expect(await run(['cleanup', '--dry-run'], dry.value, h.env)).toBe(0);
    expect(dry.out).toEqual([
      `would remove run artifacts of ${old} (age, 8 bytes)`,
      `would remove scratch directory tmp/${old}`,
    ]);
    const real = io(false);
    expect(await run(['cleanup'], real.value, h.env)).toBe(0);
    expect(real.out.filter((l) => l.startsWith('removed'))).toEqual(
      dry.out.map((l) => l.replace('would remove', 'removed')),
    );
    expect(real.out).toContain(`reconciled ${lost}: supervisor_lost`);
    expect(fs.readdirSync(path.join(h.data, 'runs', old))).toEqual(['run.json']);
    expect(fs.existsSync(path.join(h.data, 'runs', active, 'attempts'))).toBe(true);
    expect(fs.existsSync(path.join(h.data, 'tmp', active))).toBe(true);
    const after = openDataRoot(h.data);
    expect((await after.stores.runs.get(queued))?.state).toBe('queued');
    expect((await after.stores.runs.get(lost))?.state).toBe('infra_error');
    after.sql.close();
  });
});
