/**
 * Flutter adapter checks that need the filesystem or a real SDK (pure adapter tests cannot): the DISC-006 reporter
 * corpus for every captured Flutter version (FL-004), the contract kit with the real policy validator and the real
 * workspace reader over the E2E-001 fixture (FL-002/003), and `flutter test` runs of the fixture with every locally
 * installed SDK (FL-003's per-version regression). SDK runs skip, with the reason printed, when no SDK is present.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunnerOutputs, TestTarget } from '@autotest/adapter-sdk';
import { adapterContractCases } from '@autotest/adapter-sdk/testing';
import { createFlutterAdapter, flutterFailureSignals, parseFlutterResults } from '@autotest/adapter-flutter';
import { buildRegistry, nodeFsPort, validateSpec } from '@autotest/policy';
import { createWorkspaceReader } from '@autotest/workspace';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CORPUS = path.join(ROOT, 'fixtures/flutter-json');
const FIXTURE = path.join(ROOT, 'fixtures/fixture-flutter');
const F = 'attempts/1/runner/flutter.jsonl';

function corpusOutputs(text: string, interrupted = false): RunnerOutputs {
  const paths = [...new Set([...text.matchAll(/"path":"<APP>\/([^"]+)"/g)].map((m) => m[1]!))];
  const targets: TestTarget[] = paths.map((p, i) => ({
    id: `TT-flutter-${String(i).padStart(12, '0')}`,
    adapterId: 'flutter',
    level: 'unit',
    path: p,
    selector: { kind: 'file', value: p },
    platforms: ['host'],
    requires: { host: 'any', device: 'none' },
    tags: [],
  }));
  return { attemptNo: 1, targets, files: { [F]: text }, processes: [{ exitCode: 0 }], interrupted };
}

const EXPECTED: Record<string, readonly (readonly [string, string | null])[]> = {
  pass: [
    ['passed', null],
    ['passed', null],
  ],
  fail: [['failed', 'assertion']],
  error: [['failed', 'exception']],
  skip: [
    ['skipped', null],
    ['passed', null],
  ],
  load_error: [['failed', 'load_error']],
  timeout: [['failed', 'exception']],
  plain_name: [['passed', null]],
};

describe('FL-004 DISC-006 corpus across Flutter versions', () => {
  const versions = fs.readdirSync(CORPUS).filter((d) => /^\d+\.\d+\.\d+$/.test(d));
  it('covers the four captured versions', () =>
    expect(versions.sort()).toEqual(['3.38.10', '3.38.4', '3.41.9', '3.47.1']));
  for (const v of versions) {
    it(`${v}: every scenario maps to its expected outcomes`, () => {
      for (const [scenario, expected] of Object.entries(EXPECTED)) {
        const res = parseFlutterResults(
          corpusOutputs(fs.readFileSync(path.join(CORPUS, v, `${scenario}.jsonl`), 'utf8')),
        );
        expect(
          res.results.map((r) => [r.outcome, r.failureKind ?? null]),
          `${v}/${scenario}`,
        ).toEqual(expected);
        expect(res.protocol).toBe('dart-json-reporter@0.1.1');
        expect(res.diagnostics, `${v}/${scenario}`).toEqual([]);
      }
      const timeout = parseFlutterResults(
        corpusOutputs(fs.readFileSync(path.join(CORPUS, v, 'timeout.jsonl'), 'utf8')),
      );
      expect(flutterFailureSignals(timeout.results).map((s) => s.signal)).toEqual(['flutter.timeout']);
      const text = fs.readFileSync(path.join(CORPUS, v, 'interrupted.jsonl'), 'utf8');
      // RL-034: SIGTERM exits 0 and ends the running test `error` with no error event.
      expect(parseFlutterResults(corpusOutputs(text, true)).results.map((r) => r.outcome)).toEqual(['cancelled']);
      // Truncated mid-run (no done event) never yields a pass.
      const cut = text.split('\n').slice(0, 7).join('\n');
      expect(parseFlutterResults(corpusOutputs(cut)).results.map((r) => r.outcome)).toEqual(['infra_error']);
    });
  }
});

function fixtureCopy(): { dir: string; base: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-fl-')));
  const dir = path.join(base, 'app');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return { dir, base };
}

const workspaceOf = (dir: string) =>
  createWorkspaceReader({ id: 'ws_fixture', configuredPath: dir, realPath: dir, readOnlyReference: false });

describe('FL-002/003 the fixture through the real workspace reader and policy', async () => {
  const { dir, base } = fixtureCopy();
  const runDir = path.join(base, 'run');
  fs.mkdirSync(runDir);
  const fakeFlutter = path.join(base, 'flutter');
  fs.writeFileSync(fakeFlutter, '#!/bin/sh\n', { mode: 0o755 });
  const fsp = nodeFsPort();
  const registry = buildRegistry(fsp, { flutter: { path: fakeFlutter } });
  const ctx = { workspace: workspaceOf(dir), host: { os: 'macos' as const } };
  const limits = { maxFiles: 1000, maxReadBytes: 4 << 20 };
  const inv = await createFlutterAdapter().inventory({ ...ctx, limits });

  it('detects the fixture and inventories exactly its two host test files', async () => {
    expect((await createFlutterAdapter().detect(ctx)).detected).toBe(true);
    expect(inv.targets.map((t) => [t.path, t.level, t.tags])).toEqual([
      ['test/calculator_test.dart', 'unit', ['math']],
      ['test/counter_widget_test.dart', 'widget', []],
    ]);
    expect(inv.helpers).toEqual([{ path: 'test/helpers/numbers.dart', kind: 'helper' }]);
  });

  const validate = (spec: Parameters<typeof validateSpec>[0]) => {
    const r = validateSpec(spec, {
      fs: fsp,
      registry,
      workspaceRoot: dir,
      runDir,
      allowDependencyResolution: false,
      allowedClasses: ['test_runner'],
    });
    return r.ok ? { ok: true } : { ok: false, detail: r.denials.map((d) => `${d.code}:${d.detail}`).join(',') };
  };
  const fx = {
    detect: ctx,
    inventory: { ...ctx, limits },
    requests: [{ attemptNo: 1, targets: inv.targets, options: { coverage: true, timeoutMs: 60_000 } }],
    outputs: {
      attemptNo: 1,
      targets: inv.targets,
      files: { [F]: '' },
      processes: [{ exitCode: 0 }],
      interrupted: false,
    },
  };
  for (const c of adapterContractCases(createFlutterAdapter, fx, { validateSpec: validate }))
    it(`policy ${c.name}`, c.run);
});

/** Local SDKs: the one on PATH plus FVM-managed versions (`~/fvm/versions/*`). */
function localSdks(): { label: string; bin: string }[] {
  const found = new Map<string, string>();
  const onPath = spawnSync('/bin/sh', ['-c', 'command -v flutter'], { encoding: 'utf8' }).stdout.trim();
  if (onPath) found.set(fs.realpathSync(onPath), 'PATH');
  const fvm = path.join(os.homedir(), 'fvm', 'versions');
  if (process.env['AUTOTEST_FLUTTER_MATRIX'] === '1' && fs.existsSync(fvm))
    for (const v of fs.readdirSync(fvm).sort()) {
      const bin = path.join(fvm, v, 'bin', 'flutter');
      if (fs.existsSync(bin)) found.set(fs.realpathSync(bin), `fvm ${v}`);
    }
  return [...found].map(([bin, label]) => ({ bin, label }));
}

describe('FL-003/004 real flutter test runs of the fixture', () => {
  const sdks = localSdks();
  if (sdks.length === 0) {
    it.skip('no Flutter SDK on PATH (set one up to run these)', () => {});
    return;
  }
  for (const sdk of sdks) {
    it(`${sdk.label}: built specs run and parse to the fixture's known outcomes`, { timeout: 300_000 }, async () => {
      const { dir, base } = fixtureCopy();
      for (const f of ['fail', 'error', 'skip'])
        fs.copyFileSync(path.join(dir, 'test_scenarios', `${f}_test.dart`), path.join(dir, 'test', `${f}_test.dart`));
      execFileSync(sdk.bin, ['pub', 'get', '--offline'], { cwd: dir, stdio: 'ignore', timeout: 240_000 });
      const runDir = path.join(base, 'run');
      fs.mkdirSync(path.join(runDir, 'attempts/1/runner'), { recursive: true });
      const fsp = nodeFsPort();
      const registry = buildRegistry(fsp, { flutter: { path: sdk.bin } });
      const adapter = createFlutterAdapter();
      const inv = await adapter.inventory({
        workspace: workspaceOf(dir),
        host: { os: 'macos' },
        limits: { maxFiles: 100, maxReadBytes: 1 << 22 },
      });
      const [spec] = adapter.buildExecution({
        attemptNo: 1,
        targets: inv.targets,
        options: { coverage: true, timeoutMs: 240_000 },
      });
      const v = validateSpec(spec!, {
        fs: fsp,
        registry,
        workspaceRoot: dir,
        runDir,
        allowDependencyResolution: false,
        allowedClasses: ['test_runner'],
      });
      if (!v.ok) throw new Error(JSON.stringify(v.denials));
      spawnSync(v.executablePath, [...v.argv], {
        cwd: v.cwd,
        stdio: 'ignore',
        timeout: 240_000,
        env: { ...process.env, TMPDIR: base },
      });
      const read = (rel: string) =>
        fs.existsSync(path.join(runDir, rel)) ? fs.readFileSync(path.join(runDir, rel), 'utf8') : undefined;
      const res = adapter.parseResults({
        attemptNo: 1,
        targets: inv.targets,
        files: { [F]: read(F), 'attempts/1/runner/lcov.info': read('attempts/1/runner/lcov.info') },
        processes: [{ exitCode: 1 }],
        interrupted: false,
      });
      const byName = Object.fromEntries(res.results.map((r) => [r.name, [r.outcome, r.failureKind ?? null]]));
      expect(byName).toEqual({
        'add returns the sum': ['passed', null],
        'divide truncates': ['passed', null],
        'divide by zero throws ArgumentError': ['passed', null],
        'tapping increment shows Count: 1': ['passed', null],
        'add is wrong on purpose': ['failed', 'assertion'],
        'divide by zero is not caught': ['failed', 'exception'],
        'skipped on purpose': ['skipped', null],
      });
      expect(res.diagnostics).toEqual([]);
      expect(read('attempts/1/runner/lcov.info')).toContain('SF:');
    });
  }
});

describe('the default server build ships the Flutter adapter', () => {
  it(
    'inspect_project detects the fixture; the probe version survives the first-run banner',
    { timeout: 120_000 },
    async () => {
      const { composeServer, builtInAdapters } = await import('@autotest/mcp-server');
      expect(builtInAdapters().map((a) => a.id)).toEqual(['flutter']);
      // The CLI keeps its own copy of the list (apps may not import each other): both must agree.
      const { cliAdapters } = await import('@autotest/cli');
      expect(cliAdapters().map((a) => [a.id, a.version])).toEqual(builtInAdapters().map((a) => [a.id, a.version]));
      const { dir, base } = fixtureCopy();
      const data = path.join(base, 'data');
      fs.mkdirSync(data, { mode: 0o700 });
      const sdk = localSdks()[0];
      fs.writeFileSync(
        path.join(data, 'config.yaml'),
        `version: 1\nworkspaces:\n  - id: ws_fx\n    path: ${dir}\nexecutables:${sdk ? `\n  flutter: { path: ${sdk.bin} }` : ' {}'}\n`,
      );
      const c = await composeServer({ env: { AUTOTEST_HOME: data, AUTOTEST_LOG_LEVEL: 'error' } });
      const r = (await c.call('inspect_project', { workspace: 'ws_fx' })) as unknown as {
        structuredContent: {
          frameworks: { adapterId: string }[];
          toolchains: { tool: string; versionsBySource: { source: string }[] }[];
        };
      };
      expect(r.structuredContent.frameworks.map((f) => f.adapterId)).toEqual(['flutter']);
      const flutter = r.structuredContent.toolchains.find((t) => t.tool === 'flutter')!;
      if (sdk) expect(flutter.versionsBySource.map((s) => s.source)).toContain('probe:flutter --version --machine');
      await c.close();
    },
  );
});
