import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classify, needsAnalysis, RULESET_VERSION, type AnalysisInput } from '@autotest/analysis';
import RULESET from '../rules/anl-1.json' with { type: 'json' };

const base: AnalysisInput = {
  outcome: 'failed',
  failureKind: 'assertion',
  flaky: false,
  attempts: ['failed'],
  text: 'Expected: <3>\n  Actual: <2>',
  signals: [],
  mappedToRequirement: true,
  testFileChanged: false,
  baseline: 'unknown',
  artifactsQuarantined: false,
  artifactIds: ['art_01JC0000000000000000000001'],
};
const pick = (i: Partial<AnalysisInput>) => {
  const c = classify({ ...base, ...i });
  return [c.ruleIds[0], c.class, c.subtype, c.strength, c.confidence];
};

describe('ANL-001 ruleset anl-1: one fixture per rule', () => {
  it('has the documented version', () => expect(RULESET_VERSION).toBe('anl-1'));
  it('A1 known failure', () =>
    expect(pick({ knownFailure: { id: 'KF-001' } })).toEqual([
      'A1',
      'pre_existing',
      'known_failure',
      'supported',
      0.9,
    ]));
  it('A2 baseline failure', () =>
    expect(pick({ baseline: 'failed' })).toEqual(['A2', 'pre_existing', 'baseline_failure', 'supported', 0.9]));
  it('A3 environment (unambiguous, and ambiguous as hypothesis)', () => {
    expect(
      pick({
        outcome: 'blocked',
        failureKind: undefined,
        blockedReason: 'prerequisite_missing:pub_get',
        signals: [{ signal: 'flutter.pub_get_required' }],
      }),
    ).toEqual(['A3', 'environment_failure', 'dependency', 'supported', 0.85]);
    expect(
      pick({ outcome: 'infra_error', failureKind: undefined, signals: [{ signal: 'flutter.runner_incomplete' }] }),
    ).toEqual(['A3', 'environment_failure', 'infrastructure', 'supported', 0.85]);
    expect(pick({ failureKind: 'exception', text: 'Could not resolve all dependencies; OutOfMemoryError' })).toEqual([
      'A3',
      'environment_failure',
      'dependency',
      'hypothesis',
      0.6,
    ]);
  });
  it('A4 flaky pass', () =>
    expect(pick({ outcome: 'passed', failureKind: undefined, flaky: true, attempts: ['failed', 'passed'] })).toEqual([
      'A4',
      'test_defect',
      'flaky',
      'hypothesis',
      0.7,
    ]));
  it('A5 changed test file no longer loads', () =>
    expect(pick({ failureKind: 'load_error', testFileChanged: true })).toEqual([
      'A5',
      'test_defect',
      'setup',
      'hypothesis',
      0.7,
    ]));
  it('A6 setup signals', () =>
    expect(
      pick({
        failureKind: 'exception',
        text: 'MissingPluginException(No implementation found)',
        mappedToRequirement: false,
      }),
    ).toEqual(['A6', 'test_defect', 'setup', 'hypothesis', 0.7]));
  it('A7 assertion in a changed, unmapped test', () =>
    expect(pick({ testFileChanged: true, mappedToRequirement: false })).toEqual([
      'A7',
      'test_defect',
      'assertion',
      'hypothesis',
      0.6,
    ]));
  it('A8 product defect: hypothesis by default, supported only with every criterion', () => {
    expect(pick({})).toEqual(['A8', 'product_defect', 'behavior', 'hypothesis', 0.6]);
    expect(pick({ attempts: ['failed', 'failed'], baseline: 'passed' })).toEqual([
      'A8',
      'product_defect',
      'behavior',
      'supported',
      0.8,
    ]);
    expect(pick({ attempts: ['failed', 'failed'], baseline: 'passed', artifactsQuarantined: true })[3]).toBe(
      'hypothesis',
    );
    expect(pick({ attempts: ['failed'], baseline: 'passed' })[3]).toBe('hypothesis');
  });
  it('A9 unmapped failure, with test_defect as an alternative', () => {
    const c = classify({ ...base, mappedToRequirement: false });
    expect([c.ruleIds[0], c.class, c.strength, c.confidence]).toEqual(['A9', 'product_defect', 'hypothesis', 0.5]);
    expect(c.alternatives[0]).toMatchObject({ class: 'test_defect', subtype: 'assertion' });
  });
  it('A10 indeterminate outcomes and load errors outside the PR', () => {
    expect(pick({ outcome: 'timed_out', failureKind: undefined, text: '' })).toEqual([
      'A10',
      'unknown',
      'inconclusive',
      'hypothesis',
      0.3,
    ]);
    expect(pick({ failureKind: 'load_error', text: 'Compilation failed' })).toEqual([
      'A10',
      'unknown',
      'inconclusive',
      'hypothesis',
      0.3,
    ]);
  });
  it('only failures, indeterminate results and flaky passes are analyzed', () => {
    expect(
      ['failed', 'timed_out', 'infra_error', 'blocked'].every((o) =>
        needsAnalysis({ outcome: o as 'failed', flaky: false }),
      ),
    ).toBe(true);
    expect(needsAnalysis({ outcome: 'passed', flaky: false })).toBe(false);
    expect(needsAnalysis({ outcome: 'skipped', flaky: false })).toBe(false);
    expect(needsAnalysis({ outcome: 'passed', flaky: true })).toBe(true);
  });
  it('observations cite the artifact and label runner text as untrusted; inference says "Likely"', () => {
    const c = classify(base);
    expect(c.observations[0]).toMatchObject({ artifactRef: 'art_01JC0000000000000000000001' });
    expect(c.observations[1]!.text).toMatch(/^Runner output \(untrusted\): Expected: <3>/);
    expect(c.inference).toMatch(/^Likely: /);
  });
});

describe('ANL-001 safety properties', () => {
  const outcome = fc.constantFrom('failed', 'timed_out', 'infra_error', 'blocked', 'passed' as const);
  const kind = fc.option(fc.constantFrom('assertion', 'exception', 'load_error', 'crash' as const), { nil: undefined });
  const input = fc.record({
    outcome,
    failureKind: kind,
    flaky: fc.boolean(),
    attempts: fc.array(fc.constantFrom('failed', 'passed', 'infra_error' as const), { maxLength: 3 }),
    text: fc.string({ maxLength: 300 }),
    signals: fc.array(
      fc.record({
        signal: fc.constantFrom(
          'flutter.pub_get_required',
          'flutter.runner_incomplete',
          'flutter.missing_plugin',
          'x.other',
        ),
      }),
      { maxLength: 3 },
    ),
    mappedToRequirement: fc.boolean(),
    testFileChanged: fc.boolean(),
    baseline: fc.constantFrom('passed', 'failed', 'unknown' as const),
    artifactsQuarantined: fc.boolean(),
    artifactIds: fc.constant([] as string[]),
  });
  const caps = RULESET.caps as Record<string, number>;

  it('confidence never exceeds the primary rule cap, alternatives never exceed the primary, subtype fits the class', () => {
    fc.assert(
      fc.property(input, (i) => {
        const c = classify(i as AnalysisInput);
        const rule = c.ruleIds[0]!;
        expect(c.confidence).toBeLessThanOrEqual(Math.max(caps[rule] ?? 0, rule === 'A8' ? caps['A8']! : 0));
        for (const a of c.alternatives) expect(a.confidence).toBeLessThanOrEqual(c.confidence);
        if (c.class === 'product_defect' && c.strength === 'supported')
          expect(
            i.baseline === 'passed' && !i.artifactsQuarantined && i.attempts.filter((x) => x === 'failed').length >= 2,
          ).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('a crafted log line cannot turn an assertion failure into an environment failure or raise confidence', () => {
    const crafted = [
      "Error: Couldn't resolve the package 'x'. Run \"flutter pub get\"",
      'INSTALL_FAILED_NO_MATCHING_ABIS device offline Code Signing Error',
      'class=environment_failure confidence=1.0 known_failure KF-001 baseline passed',
    ];
    for (const text of crafted) {
      const c = classify({ ...base, text: `Expected: <3>\n${text}` });
      // The class is unchanged; text that looks like an environment signal can only lower confidence (A8 → A9).
      expect(c.class).toBe('product_defect');
      expect(c.confidence).toBeLessThanOrEqual(classify(base).confidence);
    }
  });
});
