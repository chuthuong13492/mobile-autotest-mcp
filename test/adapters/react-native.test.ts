import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionSpec, RunnerOutputs, TestTarget } from '@autotest/adapter-sdk';
import {
  buildReactNativeExecution,
  createReactNativeAdapter,
  detoxConfigurations,
  detoxPinConfig,
  jestLevel,
  parseReactNativeResults,
} from '@autotest/adapter-react-native';
import { fixture } from './fixtureWorkspace.ts';

type ArgToken = ExecutionSpec['args'][number];

const ROOT = path.resolve(import.meta.dirname, '../../fixtures');
const adapter = createReactNativeAdapter();
const ctx = { workspace: fixture(path.join(ROOT, 'fixture-react-native')), host: { os: 'macos' as const } };
const UDID = 'A59793A1-207D-4223-9A07-7A25E3124218';

async function inventory(): Promise<readonly TestTarget[]> {
  return (await adapter.inventory({ ...ctx, limits: { maxFiles: 1000, maxReadBytes: 1 << 24 } })).targets;
}
const render = (a: ArgToken) =>
  a.kind === 'word'
    ? a.value
    : a.kind === 'flag'
      ? [a.name, a.value].filter(Boolean).join(' ')
      : a.kind === 'workspacePath'
        ? `ws:${a.rel}`
        : `${'name' in a ? `${a.name} ` : ''}run:${a.rel}`;
const request = (targets: readonly TestTarget[], device?: { platform: 'ios' | 'android'; id: string }) => ({
  targets,
  attemptNo: 1,
  options: { timeoutMs: 600_000, coverage: false },
  ...(device ? { device } : {}),
});
const sel = (t: TestTarget) => t.selector?.value ?? '';

describe('RN-001 detection and inventory (fixture-react-native, static)', () => {
  it('detects React Native with its runners and platforms', async () => {
    const d = await adapter.detect(ctx);
    expect(d).toMatchObject({ detected: true, evidence: ['package.json', 'app.json', 'metro.config.js'] });
    expect(d.platforms.map((p) => p.platform)).toEqual(['ios', 'android']);
    expect(d.runners.map((r) => r.kind)).toEqual(['jest', 'detox', 'maestro']);
    // A checkout without node_modules (CI) is reported, never installed.
    expect(d.limitations.every((l) => l.code === 'rn:node_modules_missing')).toBe(true);
  });

  it('lists Jest files on the host, and Maestro flows and Detox files per platform', async () => {
    expect((await inventory()).map((t) => [t.path, t.level, sel(t), t.requires.device])).toEqual([
      ['__tests__/App.test.tsx', 'component', 'jest', 'none'],
      ['__tests__/calculator.test.ts', 'unit', 'jest', 'none'],
      ['__tests__/scenario.test.ts', 'unit', 'jest', 'none'],
      ['.maestro/counter.yaml', 'e2e', 'maestro|ios', 'simulator'],
      ['.maestro/counter.yaml', 'e2e', 'maestro|android', 'emulator'],
      ['.maestro/wrong-count.yaml', 'e2e', 'maestro|ios', 'simulator'],
      ['.maestro/wrong-count.yaml', 'e2e', 'maestro|android', 'emulator'],
      ['e2e/counter.test.js', 'e2e', 'detox|android.att.release|.detoxrc.js', 'emulator'],
      ['e2e/counter.test.js', 'e2e', 'detox|ios.sim.release|.detoxrc.js', 'simulator'],
    ]);
  });

  it('reads Detox configurations from JSON and JS configs without running them', () => {
    expect(
      detoxConfigurations(
        JSON.stringify({
          devices: { sim: { type: 'ios.simulator' }, emu: { type: 'android.emulator' } },
          configurations: { 'a.debug': { device: 'sim' }, 'b.debug': { device: 'emu' } },
        }),
      ),
    ).toEqual([
      { name: 'a.debug', platform: 'ios' },
      { name: 'b.debug', platform: 'android' },
    ]);
    expect(jestLevel("import { render } from '@testing-library/react-native';")).toBe('component');
    expect(jestLevel("import { add } from '../src/add';")).toBe('unit');
  });
});

describe('RN-002/003 execution specs', () => {
  it('runs the workspace Jest directly, with JSON into the run directory', async () => {
    const specs = buildReactNativeExecution(request((await inventory()).filter((t) => sel(t) === 'jest')));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.executable).toBe('node');
    expect(specs[0]!.args.map(render)).toEqual([
      'ws:node_modules/jest/bin/jest.js',
      '--ci',
      '--json',
      '--outputFile run:attempts/1/runner/jest.json',
      '--testLocationInResults',
      '--no-watchman',
      '--runTestsByPath',
      'ws:__tests__/App.test.tsx',
      'ws:__tests__/calculator.test.ts',
      'ws:__tests__/scenario.test.ts',
    ]);
  });

  it('runs Maestro flows and Detox on the run device only, pinning Detox to it', async () => {
    const ios = (await inventory()).filter((t) => /maestro\|ios|ios\.sim/.test(sel(t)));
    expect(buildReactNativeExecution(request(ios))).toEqual([]);
    const specs = buildReactNativeExecution(request(ios, { platform: 'ios', id: UDID }));
    expect(specs.map((s) => s.args.map(render).slice(0, 2).join(' '))).toEqual([
      `test --udid ${UDID}`,
      'ws:node_modules/detox/local-cli/cli.js build-framework-cache',
      'ws:node_modules/detox/local-cli/cli.js test',
    ]);
    expect(specs[0]!.args.map(render).slice(-2)).toEqual(['ws:.maestro/counter.yaml', 'ws:.maestro/wrong-count.yaml']);
    expect(specs[2]!.args.map(render)).toContain('--configuration ios.sim.release');
    expect(specs[2]!.files).toEqual([
      {
        rel: 'attempts/1/runner/detox.config.js',
        content: detoxPinConfig('.detoxrc.js', 'ios.sim.release', { platform: 'ios', id: UDID }),
      },
    ]);
    expect(specs[2]!.files![0]!.content).toContain(`{"type":"ios.simulator","device":{"id":"${UDID}"}}`);
    const android = (await inventory()).filter((t) => /android/.test(sel(t)));
    const a = buildReactNativeExecution(request(android, { platform: 'android', id: 'emulator-5584' }));
    expect(a).toHaveLength(2);
    expect(a[1]!.files![0]!.content).toContain('{"type":"android.attached","device":{"adbName":"emulator-5584"}}');
  });
});

describe('RN-002 Jest JSON parsing (Jest 29.7 corpus)', () => {
  it('maps passed, failed, skipped and component tests to their files', async () => {
    const targets = (await inventory()).filter((t) => sel(t) === 'jest');
    const outputs: RunnerOutputs = {
      attemptNo: 1,
      targets,
      files: {
        'attempts/1/runner/jest.json': fs.readFileSync(path.join(ROOT, 'rn-corpus/jest-29.7.0/jest.json'), 'utf8'),
      },
      processes: [{ exitCode: 1 }],
      interrupted: false,
    };
    const parsed = parseReactNativeResults(outputs);
    expect(
      Object.fromEntries(parsed.results.map((r) => [r.name, [r.suitePath, r.outcome, r.failureKind ?? null]])),
    ).toEqual({
      'renders the count': ['__tests__/App.test.tsx', 'passed', null],
      'calculator add returns the sum': ['__tests__/calculator.test.ts', 'passed', null],
      'calculator dividing by zero returns null': ['__tests__/calculator.test.ts', 'passed', null],
      'add is wrong on purpose': ['__tests__/scenario.test.ts', 'failed', 'assertion'],
      'skipped on purpose': ['__tests__/scenario.test.ts', 'skipped', null],
    });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.results.find((r) => r.outcome === 'failed')?.messageExcerpt).not.toContain(String.fromCharCode(27));
  });

  it('reports a file that failed to load, and a missing report', async () => {
    const targets = (await inventory()).filter((t) => sel(t) === 'jest');
    const broken = JSON.stringify({
      testResults: [
        { name: '/w/__tests__/scenario.test.ts', status: 'failed', message: 'SyntaxError: x', assertionResults: [] },
      ],
    });
    const p = parseReactNativeResults({
      attemptNo: 1,
      targets,
      files: { 'attempts/1/runner/jest.json': broken },
      processes: [{ exitCode: 1 }],
      interrupted: false,
    });
    expect(p.results).toMatchObject([{ suitePath: '__tests__/scenario.test.ts', failureKind: 'load_error' }]);
    expect(
      parseReactNativeResults({ attemptNo: 1, targets, files: {}, processes: [{ exitCode: 1 }], interrupted: false })
        .diagnostics,
    ).toEqual([{ code: 'runner_incomplete', message: 'no jest report (exit 1)' }]);
  });
});
