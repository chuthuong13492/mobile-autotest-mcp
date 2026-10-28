import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProbePort, RunnerOutputs, TestTarget } from '@autotest/adapter-sdk';
import {
  buildAppiumExecution,
  createAppiumAdapter,
  kebabCase,
  mapScenariosToSpecs,
  parseAppiumResults,
  READY_TEXT,
  scenariosFromList,
  scenariosFromRegistry,
} from '@autotest/adapter-appium';
import { fixture } from './fixtureWorkspace.ts';

const ROOT = path.resolve(import.meta.dirname, '../../fixtures');
const adapter = createAppiumAdapter();
const ctx = { workspace: fixture(path.join(ROOT, 'fixture-react-native')), host: { os: 'macos' as const } };

async function inventory(): Promise<readonly TestTarget[]> {
  return (await adapter.inventory({ ...ctx, limits: { maxFiles: 1000, maxReadBytes: 1 << 24 } })).targets;
}
const probes = (server: string, drivers: Record<string, { version: string }>): ProbePort => ({
  async probe(kind) {
    if (kind === 'appium_version') return { available: true, stdout: `${server}\n`, exitCode: 0 };
    if (kind === 'appium_drivers') return { available: true, stdout: JSON.stringify(drivers), exitCode: 0 };
    return { available: false, reason: 'n/a' };
  },
});
const request = (targets: readonly TestTarget[], device?: { platform: 'ios' | 'android'; id: string }) => ({
  targets,
  attemptNo: 1,
  options: { timeoutMs: 600_000, coverage: false },
  ...(device ? { device } : {}),
});

describe('APM-001 detection, inventory and version pinning (fixture-react-native)', () => {
  it('detects the pinned suite and lists one target per scenario, linked to its spec', async () => {
    expect(await adapter.detect(ctx)).toMatchObject({
      detected: true,
      evidence: ['.autotest/appium.json', 'appium/scenario-list.json'],
      runners: [{ kind: 'appium', configured: true }],
      limitations: [],
    });
    expect((await inventory()).map((t) => [t.path, t.selector?.value, t.tags])).toEqual([
      [
        'appium/scenario-list.json#counterIncrements',
        'android|counterIncrements|4725|dp|.|appium/run-scenario.mjs',
        ['spec:counter-increments'],
      ],
      [
        'appium/scenario-list.json#counterIsFiveOnPurpose',
        'android|counterIsFiveOnPurpose|4725|dp|.|appium/run-scenario.mjs',
        [],
      ],
    ]);
  });

  it('requires the installed Appium server and drivers to equal the pin', async () => {
    const pre = (p: ProbePort) => adapter.prerequisites!({ ...ctx, probes: p });
    expect(await pre(probes('3.4.2', { uiautomator2: { version: '8.7.0' } }))).toEqual({
      satisfied: true,
      missing: [],
    });
    expect(await pre(probes('3.8.0', {}))).toEqual({
      satisfied: false,
      missing: [
        { code: 'prerequisite_mismatch', message: 'Appium 3.8.0 is installed, 3.4.2 is pinned' },
        { code: 'prerequisite_mismatch', message: 'driver uiautomator2 not installed, 8.7.0 is pinned' },
      ],
    });
    // Without a pin file the suite is listed but never runs.
    const other = { workspace: fixture(path.join(ROOT, 'fixture-flutter')), host: { os: 'macos' as const } };
    expect((await adapter.prerequisites!(other)).missing.map((m) => m.code)).toEqual(['appium_not_pinned']);
  });
});

describe('APM-001 execution and results', () => {
  it('starts the Appium server as a background service, then one process per scenario', async () => {
    const targets = await inventory();
    expect(buildAppiumExecution(request(targets))).toEqual([]);
    expect(
      buildAppiumExecution(request(targets, { platform: 'ios', id: 'A59793A1-207D-4223-9A07-7A25E3124218' })),
    ).toEqual([]);
    const specs = buildAppiumExecution(request(targets, { platform: 'android', id: 'emulator-5584' }));
    expect(specs.map((s) => s.executable)).toEqual(['appium', 'node', 'node']);
    expect(specs[0]!.background).toEqual({ readyText: READY_TEXT, readyTimeoutMs: 120_000 });
    expect(specs[0]!.args).toContainEqual({ kind: 'flag', name: '--address', value: '127.0.0.1' });
    expect(specs[1]!.args).toEqual([
      { kind: 'workspacePath', rel: 'appium/run-scenario.mjs' },
      { kind: 'flag', name: '--scenario', value: 'counterIncrements' },
      { kind: 'flag', name: '--udid', value: 'emulator-5584' },
      { kind: 'flag', name: '--port', value: '4725' },
      { kind: 'flag', name: '--platform', value: 'android' },
    ]);
  });

  it('maps exit codes to per-scenario results', async () => {
    const targets = await inventory();
    const outputs: RunnerOutputs = {
      attemptNo: 1,
      targets,
      files: { 'attempts/1/stdout-2.log': 'scenario counterIsFiveOnPurpose: AssertionError: expected "Count: 5"' },
      processes: [{}, { exitCode: 0 }, { exitCode: 1 }],
      interrupted: false,
    };
    expect(parseAppiumResults(outputs).results.map((r) => [r.name, r.outcome, r.failureKind ?? null])).toEqual([
      ['counterIncrements', 'passed', null],
      ['counterIsFiveOnPurpose', 'failed', 'assertion'],
    ]);
  });
});

describe('APM-002 scenario-to-spec mapping', () => {
  it('reads scenario registries and lists, and maps names to kebab-case specs ignoring separators', () => {
    expect(
      scenariosFromRegistry(
        `switch (s) {\n case "verifyVdpSharing":\n  break;\n case 'verifyVDPBackButton': break;\n}`,
      ),
    ).toEqual(['verifyVdpSharing', 'verifyVDPBackButton']);
    expect(scenariosFromList('["a1", {"name": "b2"}, 3, "a1", "../x"]')).toEqual(['a1', 'b2']);
    expect(kebabCase('verifyVDPBackButton')).toBe('verify-vdp-back-button');
    const m = mapScenariosToSpecs(
      ['verifyVDPBackButton', 'verifyBackArrowButtonFiltertoSRP', 'verifyAIBottomNav'],
      [
        'spec/README.md',
        'spec/vdp/verify-vdp-back-button.md',
        'spec/srp/verify-back-arrow-button-filter-to-srp.md',
        'spec/x/orphan.md',
      ],
    );
    expect([...m.mapped]).toEqual([
      ['verifyVDPBackButton', 'spec/vdp/verify-vdp-back-button.md'],
      ['verifyBackArrowButtonFiltertoSRP', 'spec/srp/verify-back-arrow-button-filter-to-srp.md'],
    ]);
    expect(m.unmappedScenarios).toEqual(['verifyAIBottomNav']);
    expect(m.orphanSpecs).toEqual(['spec/x/orphan.md']);
  });
});
