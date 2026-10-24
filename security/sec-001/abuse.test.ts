/**
 * SEC-001: command, path, environment and artifact abuse cases against policy, exec, workspace and evidence, each
 * tagged with the threat it covers (docs/security-threat-model.md). The last case checks that every threat this
 * suite owns has at least one case (the T-ID coverage report).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIdGenerator, TOOLS, type ArgToken, type ExecutionSpec } from '@autotest/core';
import { ingestArtifacts } from '@autotest/evidence';
import { spawnSpec, truncationMarker } from '@autotest/exec';
import { buildRegistry, createRedactor, loadPolicyConfig, nodeFsPort, validateSpec } from '@autotest/policy';
import { createWorkspaceReader } from '@autotest/workspace';
import { fixture, spec, tmp } from '../../packages/exec/test/helpers.ts';

const covered = new Set<string>();
const T = (ids: string, name: string, fn: () => Promise<void> | void) => {
  for (const id of ids.split(',')) covered.add(id.trim());
  it(`[${ids}] ${name}`, fn);
};
const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('SEC-001 command, path, environment and artifact abuse', () => {
  T('T-03', 'no tool input has a command, argv, shell or script field', () => {
    const forbidden = /^(command|commands|argv|args|arguments|shell|script|executable|cmd|exec)$/i;
    const walk = (schema: unknown, at: string): string[] => {
      if (!schema || typeof schema !== 'object') return [];
      const s = schema as {
        properties?: Record<string, unknown>;
        items?: unknown;
        anyOf?: unknown[];
        oneOf?: unknown[];
      };
      return [
        ...Object.entries(s.properties ?? {}).flatMap(([k, v]) => [
          ...(forbidden.test(k) ? [`${at}.${k}`] : []),
          ...walk(v, `${at}.${k}`),
        ]),
        ...walk(s.items, `${at}[]`),
        ...(s.anyOf ?? []).flatMap((x, i) => walk(x, `${at}|${i}`)),
        ...(s.oneOf ?? []).flatMap((x, i) => walk(x, `${at}|${i}`)),
      ];
    };
    const hits = TOOLS.flatMap((t) => walk(t.input.toJSONSchema(), t.name));
    expect(hits).toEqual([]);
  });

  T(
    'T-03',
    'only allowlisted logical executables run; PATH is never searched; argument smuggling is denied',
    async () => {
      const f = fixture();
      expect(await spawnSpec({ ...spec('echo-args'), executable: 'sh' }, f.ctx())).toMatchObject({
        ok: false,
        denials: [{ code: 'unknown_executable' }],
      });
      for (const extra of [
        [{ kind: 'flag' as const, name: '--update-goldens' }],
        [{ kind: 'flag' as const, name: '--dart-define', value: 'X=1' }],
        [{ kind: 'flag' as const, name: '--enable-vmservice' }],
        [{ kind: 'word' as const, value: 'pub' }],
        [{ kind: 'runPath' as const, rel: 'x' }],
      ])
        expect((await spawnSpec(spec('echo-args', extra), f.ctx())).ok, JSON.stringify(extra)).toBe(false);
      const relative = loadPolicyConfig('version: 1\nexecutables: { flutter: { path: flutter } }\n');
      expect(relative.ok).toBe(false);
    },
  );

  T('T-03', 'shell metacharacters in a test file name reach the runner as one literal argument', async () => {
    const f = fixture();
    const evil = 'test/a;touch PWNED $(touch PWNED2) `id`_test.dart';
    fs.writeFileSync(path.join(f.ws, evil), '');
    const c = f.ctx();
    const r = await spawnSpec(spec('echo-args', [{ kind: 'workspacePath', rel: evil }]), c);
    if (!r.ok) throw new Error(JSON.stringify(r.denials));
    await r.process.exited;
    expect(read(c.stdoutPath).trimEnd().split('\n').at(-1)).toBe(path.join(f.ws, evil));
    expect(fs.existsSync(path.join(f.ws, 'PWNED')) || fs.existsSync(path.join(f.ws, 'PWNED2'))).toBe(false);
  });

  T('T-04', 'path traversal and symlink escapes are denied for test paths, run paths and listings', async () => {
    const f = fixture();
    const outside = tmp('autotest-outside-');
    fs.writeFileSync(path.join(outside, 'x_test.dart'), '');
    fs.symlinkSync(path.join(outside, 'x_test.dart'), path.join(f.ws, 'test', 'link_test.dart'));
    fs.symlinkSync(outside, path.join(f.ws, 'test', 'linked_dir'));
    const deny = async (tok: Parameters<typeof spec>[1]) => (await spawnSpec(spec('echo-args', tok), f.ctx())).ok;
    expect(await deny([{ kind: 'workspacePath', rel: '../x_test.dart' }])).toBe(false);
    expect(await deny([{ kind: 'workspacePath', rel: 'test/link_test.dart' }])).toBe(false);
    expect(await deny([{ kind: 'workspacePath', rel: `${outside}/x_test.dart` }])).toBe(false);
    expect(
      await deny([{ kind: 'flagRunPath', name: '--file-reporter', rel: '../../escape.jsonl', prefix: 'json:' }]),
    ).toBe(false);
    const reader = createWorkspaceReader({
      id: 'ws_app',
      configuredPath: f.ws,
      realPath: f.ws,
      readOnlyReference: false,
    });
    const listed = reader.list(['test/**/*_test.dart']).files;
    expect(listed).toContain('test/a_test.dart');
    expect(listed.some((p) => p.includes('linked_dir') || p.includes('link_test'))).toBe(false);
    expect(() => reader.readText('test/link_test.dart')).toThrow();
  });

  T(
    'T-02,T-05',
    'children get a minimal environment: parent secrets, tokens and loader hooks never reach them',
    async () => {
      const f = fixture();
      const c = f.ctx({
        parentEnv: {
          JAVA_HOME: '/opt/jdk',
          GITHUB_TOKEN: 'ghp_canary_must_not_leak',
          AWS_SECRET_ACCESS_KEY: 'canary-aws',
          NODE_OPTIONS: '--require /tmp/evil.js',
          DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
          LD_PRELOAD: '/tmp/evil.so',
          HOME: '/Users/real-user',
          PATH: '/evil',
        },
      });
      const r = await spawnSpec(spec('env'), c);
      if (!r.ok) throw new Error('denied');
      await r.process.exited;
      const env = read(c.stdoutPath);
      for (const leaked of [
        'ghp_canary_must_not_leak',
        'canary-aws',
        'NODE_OPTIONS',
        'DYLD_INSERT_LIBRARIES',
        'LD_PRELOAD',
        '/Users/real-user',
        '/evil',
      ])
        expect(env, leaked).not.toContain(leaked);
      expect(env).toContain(`HOME=${c.home}`);
    },
  );

  T('T-05', 'redaction canaries in runner output never reach stored evidence', () => {
    const dir = tmp('autotest-canary-');
    const canaries = [
      `ghp_${'A1b2C3d4E5f6G7h8I9j0'}K1l2M3n4O5p6Q7r8`,
      'AKIA' + 'IOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----',
      'password: "correct horse battery staple"',
    ];
    fs.mkdirSync(path.join(dir, 'attempts/1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'attempts/1/stdout-0.log'), canaries.join('\n'));
    const ids = createIdGenerator();
    const { artifacts } = ingestArtifacts(
      [
        {
          kind: 'stdout',
          rel: 'attempts/1/stdout-0.log',
          mimeType: 'text/plain',
          required: true,
          producer: 'supervisor',
        },
      ],
      {
        runDir: dir,
        runId: 'run_01JC000000000000000000000A',
        newId: () => ids.newId('art'),
        redactor: createRedactor(),
      },
    );
    const stored = read(path.join(dir, artifacts[0]!.relativePath));
    for (const c of [
      'A1b2C3d4E5f6G7h8I9j0K1l2',
      'IOSFODNN7EXAMPLE',
      'dozjgNryP4J3jVmNHl0w5N',
      'MIIEvQIBADANBgkqhkiG9w0',
      'correct horse battery staple',
    ])
      expect(stored, c).not.toContain(c);
  });

  T(
    'T-07',
    'output floods are capped; oversized, binary and symlinked artifacts are truncated or quarantined',
    async () => {
      const f = fixture();
      const c = f.ctx({ outputCapBytes: 10_000 });
      const r = await spawnSpec(spec('flood'), c);
      if (!r.ok) throw new Error('denied');
      const exit = await r.process.exited;
      expect(fs.statSync(c.stdoutPath).size).toBe(10_000 + Buffer.byteLength(truncationMarker(10_000)));
      expect(read(c.stdoutPath).endsWith(truncationMarker(10_000))).toBe(true);
      expect(exit.stdout.truncated).toBe(true);
      const dir = tmp('autotest-art-');
      fs.mkdirSync(path.join(dir, 'attempts/1/runner'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'attempts/1/runner/flutter.jsonl'),
        Buffer.concat([Buffer.from('{}\n'), Buffer.from([0, 0, 0])]),
      );
      fs.writeFileSync(path.join(dir, 'attempts/1/stdout-0.log'), 'x'.repeat(50_000));
      fs.symlinkSync('/etc/passwd', path.join(dir, 'attempts/1/stderr-0.log'));
      const ids = createIdGenerator();
      const { artifacts } = ingestArtifacts(
        [
          {
            kind: 'runner_json',
            rel: 'attempts/1/runner/flutter.jsonl',
            mimeType: 'application/x-ndjson',
            required: true,
            producer: 'flutter',
          },
          {
            kind: 'stdout',
            rel: 'attempts/1/stdout-0.log',
            mimeType: 'text/plain',
            required: true,
            producer: 'supervisor',
          },
          {
            kind: 'stderr',
            rel: 'attempts/1/stderr-0.log',
            mimeType: 'text/plain',
            required: true,
            producer: 'supervisor',
          },
        ],
        {
          runDir: dir,
          runId: 'run_01JC000000000000000000000A',
          newId: () => ids.newId('art'),
          redactor: createRedactor(),
          maxBytes: 4096,
        },
      );
      expect(artifacts.map((a) => [a.quarantined, a.quarantineReason ?? null, a.truncated])).toEqual([
        [true, 'binary_as_text', false],
        [false, null, true],
        [true, 'symlink', false],
      ]);
    },
  );

  T('T-08', 'dependency resolution is off by default and every Flutter test spec carries --no-pub', () => {
    const f = fixture();
    const pubGet = {
      ...spec('x'),
      args: [
        { kind: 'word' as const, value: 'pub' },
        { kind: 'word' as const, value: 'get' },
        { kind: 'flag' as const, name: '--enforce-lockfile' },
      ],
    };
    expect(validateSpec(pubGet, { ...f.ctx(), allowDependencyResolution: false })).toMatchObject({
      ok: false,
      denials: [{ code: 'gated' }],
    });
    const noNoPub = { ...spec('x'), args: spec('x').args.filter((a) => !(a.kind === 'flag' && a.name === '--no-pub')) };
    expect(validateSpec(noNoPub, f.ctx())).toMatchObject({
      ok: false,
      denials: [{ code: 'missing_flag', detail: '--no-pub' }],
    });
  });

  T('T-11', 'two runs get separate private run directories and scratch HOME/TMPDIR', async () => {
    const a = fixture();
    const b = fixture();
    expect(a.runDir).not.toBe(b.runDir);
    const ca = a.ctx();
    const r = await spawnSpec(spec('env'), ca);
    if (!r.ok) throw new Error('denied');
    await r.process.exited;
    expect(fs.statSync(ca.home).mode & 0o077).toBe(0);
    expect(fs.statSync(ca.tmpDir).mode & 0o077).toBe(0);
    expect(ca.home.startsWith(a.runDir)).toBe(true);
    expect(b.ctx().home.startsWith(b.runDir)).toBe(true);
  });

  T('T-17', 'the data root is private: directory 0700, config, database and approval files 0600', async () => {
    const { openDataRoot } = await import('@autotest/storage');
    const data = path.join(tmp('autotest-dr-'), 'data');
    fs.mkdirSync(data, { mode: 0o700 });
    const { sql, stores } = openDataRoot(data);
    await stores.audit.append({
      ts: '2026-10-23T00:00:00Z',
      actor: 'cli',
      kind: 'approval.revoked',
      subjectRefs: [],
      data: { approvalId: 'appr_01JC0000000000000000000001' },
    });
    sql.close();
    const walk = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory() ? [path.join(d, e.name) + '/', ...walk(path.join(d, e.name))] : [path.join(d, e.name)],
        );
    for (const p of [data + '/', ...walk(data)]) {
      const mode = fs.statSync(p).mode & 0o777;
      expect(mode & 0o077, `${p} ${mode.toString(8)}`).toBe(0);
    }
    fs.chmodSync(data, 0o755);
    expect(() => openDataRoot(data)).toThrow(/group\/world/);
    expect(buildRegistry(nodeFsPort(), {}).executables.size).toBe(0);
  });

  T('T-03,T-08', 'git (baseline worktrees) cannot fetch, run hooks, or write outside the run directory', () => {
    const root = tmp('autotest-git-');
    fs.writeFileSync(path.join(root, 'git'), '#!/bin/sh\n', { mode: 0o755 });
    const run = tmp('autotest-gitrun-');
    const ctx = {
      fs: nodeFsPort(),
      registry: buildRegistry(nodeFsPort(), { git: { path: path.join(root, 'git') } }),
      workspaceRoot: root,
      runDir: run,
      allowDependencyResolution: true,
    };
    const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never']
      .concat(['-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false'])
      .map((value) => ({ kind: 'word' as const, value }));
    const gitSpec = (args: ArgToken[]): ExecutionSpec => ({
      ...spec('x'),
      executable: 'git',
      args,
      cancellation: 'process_group',
    });
    const g = (...args: ArgToken[]) => validateSpec(gitSpec([...SAFE, ...args]), ctx).ok;
    const w = (value: string) => ({ kind: 'word' as const, value });
    expect(g(w('worktree'), w('prune'))).toBe(true);
    // No fetch/clone/config/submodule/push form exists, even with dependency resolution allowed.
    for (const sub of ['fetch', 'clone', 'pull', 'push', 'config', 'submodule', 'lfs', 'archive'])
      expect(g(w(sub)), sub).toBe(false);
    // Without the fixed safety options (hooks off, no transport) nothing is accepted.
    expect(validateSpec(gitSpec([w('worktree'), w('prune')]), ctx).ok).toBe(false);
    // The worktree path is fixed to <runDir>/baseline: no escape, no workspace path.
    const add = (rel: string) => g(w('worktree'), w('add'), w('--detach'), { kind: 'runPath', rel }, w('a'.repeat(40)));
    expect(add('baseline')).toBe(true);
    for (const rel of ['../x', 'baseline/../../x', 'other']) expect(add(rel), rel).toBe(false);
    expect(g(w('worktree'), w('add'), w('--detach'), { kind: 'workspacePath', rel: 'x' }, w('a'.repeat(40)))).toBe(
      false,
    );
  });

  it('T-ID coverage report: every threat SEC-001 owns has a case', () => {
    const owned = ['T-02', 'T-03', 'T-04', 'T-05', 'T-07', 'T-08', 'T-11', 'T-17'];
    console.log(
      `SEC-001 T-ID coverage: ${owned.map((t) => `${t}:${covered.has(t) ? 'covered' : 'MISSING'}`).join(' ')}`,
    );
    expect(owned.filter((t) => !covered.has(t))).toEqual([]);
  });
});
