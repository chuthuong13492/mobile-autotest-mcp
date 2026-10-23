import { describe, expect, it } from 'vitest';
import { createAdapterRegistry, eligibilityOf, type PlatformAdapter } from '@autotest/adapter-sdk';
import { adapterContractCases, createExampleAdapter, EXAMPLE_CAPABILITIES } from '@autotest/adapter-sdk/testing';
import { exampleFixtures, memoryWorkspace } from './fixtures.ts';

const fx = await exampleFixtures();

/** Runs all kit cases and returns the names of the failing ones. */
async function failing(make: () => PlatformAdapter, options = {}): Promise<string[]> {
  const out: string[] = [];
  for (const c of adapterContractCases(make, fx, options)) {
    try {
      await c.run();
    } catch {
      out.push(c.name);
    }
  }
  return out;
}

describe('ADP-001 contract kit', () => {
  for (const c of adapterContractCases(createExampleAdapter, fx, { validateSpec: () => ({ ok: true }) }))
    it(`example adapter — ${c.name}`, c.run);

  it('a non-deterministic adapter fails the determinism case', async () => {
    let n = 0;
    const flaky = (): PlatformAdapter => {
      const base = createExampleAdapter();
      return {
        ...base,
        buildExecution: (req) => base.buildExecution(req).map((s) => ({ ...s, timeoutMs: s.timeoutMs + n++ })),
      };
    };
    expect(await failing(flaky)).toEqual(['adapter kit: buildExecution is deterministic and every spec is valid']);
  });

  it('a parser that throws on bad input fails the robustness case', async () => {
    const fragile = (): PlatformAdapter => {
      const base = createExampleAdapter();
      return {
        ...base,
        parseResults: (o) => {
          const t = Object.values(o.files)[0];
          if (!t || !t.startsWith('RESULT')) throw new Error('boom');
          return base.parseResults(o);
        },
      };
    };
    expect(await failing(fragile)).toContain(
      'adapter kit: parsing is total — truncated, malformed, empty, missing and oversized outputs never throw',
    );
  });

  it('specs outside the contract or denied by policy fail', async () => {
    const escaping = (): PlatformAdapter => {
      const base = createExampleAdapter();
      return {
        ...base,
        buildExecution: (req) =>
          base
            .buildExecution(req)
            .map((s) => ({ ...s, args: [...s.args, { kind: 'workspacePath', rel: '../outside_test.dart' }] })),
      };
    };
    expect(await failing(escaping)).toEqual(['adapter kit: buildExecution is deterministic and every spec is valid']);
    expect(
      await failing(createExampleAdapter, { validateSpec: () => ({ ok: false, detail: 'forbidden_flag' }) }),
    ).toEqual(['adapter kit: buildExecution is deterministic and every spec is valid']);
  });

  it('an adapter without detection evidence fails', async () => {
    const vague = (): PlatformAdapter => {
      const base = createExampleAdapter();
      return { ...base, detect: async (ctx) => ({ ...(await base.detect(ctx)), evidence: [] }) };
    };
    expect(await failing(vague)).toEqual(['adapter kit: detect reports evidence and is deterministic']);
  });
});

describe('ADP-001 registry and eligibility', () => {
  it('detects with every adapter, orders by confidence and survives a throwing adapter', async () => {
    const broken: PlatformAdapter = {
      ...createExampleAdapter(),
      id: 'broken',
      detect: async () => Promise.reject(new Error('x')),
    };
    const other: PlatformAdapter = {
      ...createExampleAdapter(),
      id: 'other',
      detect: async () => ({
        adapterId: 'other',
        detected: false,
        confidence: 0,
        evidence: [],
        platforms: [],
        toolchains: [],
        runners: [],
        limitations: [],
      }),
    };
    const reg = createAdapterRegistry([other, broken, createExampleAdapter()]);
    expect(reg.adapters.map((a) => a.id)).toEqual(['broken', 'example', 'other']);
    const d = await reg.detectAll({ workspace: memoryWorkspace({ 'example.json': '' }), host: { os: 'linux' } });
    expect(d.map((x) => [x.adapterId, x.confidence])).toEqual([
      ['example', 0.9],
      ['broken', 0],
      ['other', 0],
    ]);
    expect(d[1]!.limitations[0]!.code).toBe('adapter_failed');
    expect(() => createAdapterRegistry([createExampleAdapter(), createExampleAdapter()])).toThrow(/duplicate/);
    expect(() => createAdapterRegistry([{ ...createExampleAdapter(), id: 'Bad Id' }])).toThrow(/invalid/);
  });

  it('computes FR-014 eligibility from capabilities, host, devices and executables', () => {
    const t = fx.requests[0]!.targets[0]!;
    const base = { capabilities: EXAMPLE_CAPABILITIES, hostOs: 'linux' as const, executableAvailable: true };
    expect(eligibilityOf(t, base)).toBe('eligible');
    expect(eligibilityOf({ ...t, level: 'e2e' }, base)).toBe('ineligible:capability_missing');
    expect(eligibilityOf({ ...t, requires: { host: 'macos', device: 'none' } }, base)).toBe(
      'ineligible:platform_unavailable',
    );
    expect(eligibilityOf({ ...t, requires: { host: 'macos', device: 'none' } }, { ...base, hostOs: 'macos' })).toBe(
      'eligible',
    );
    expect(eligibilityOf({ ...t, requires: { host: 'any', device: 'simulator' } }, base)).toBe(
      'ineligible:platform_unavailable',
    );
    expect(
      eligibilityOf({ ...t, requires: { host: 'any', device: 'simulator' } }, { ...base, deviceAvailable: true }),
    ).toBe('eligible');
    expect(eligibilityOf(t, { ...base, executableAvailable: false })).toBe('ineligible:policy_denied');
    expect(
      eligibilityOf(t, {
        ...base,
        capabilities: { ...EXAMPLE_CAPABILITIES, host: { requires: 'any', available: false } },
      }),
    ).toBe('ineligible:platform_unavailable');
  });

  it('resolves plan test cases to inventory targets', () => {
    const a = createExampleAdapter();
    const targets = fx.requests[0]!.targets;
    const r = a.resolveTargets({
      targets,
      testCases: [
        { id: 'TC-001', targetRef: targets[0]!.id, level: 'unit', platforms: ['host'] },
        { id: 'TC-002', targetRef: null, level: 'manual', platforms: ['host'] },
        { id: 'TC-003', targetRef: 'TT-example-000000000000', level: 'unit', platforms: ['host'] },
      ],
    });
    expect(r).toEqual({
      resolved: [{ testCaseId: 'TC-001', targetId: targets[0]!.id }],
      unresolved: [
        { testCaseId: 'TC-002', reason: 'no_target' },
        { testCaseId: 'TC-003', reason: 'target_not_in_inventory' },
      ],
    });
  });
});
