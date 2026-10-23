import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateGate, hasObservable } from '@autotest/coverage-gate';
import { build, CONFIG, input, NOW, req, tc } from './fixtures.ts';

const rules = (b: ReturnType<typeof build>, over = {}) => evaluateGate(input(b, over)).findings.map((f) => f.ruleId);
const exc = (over: Record<string, unknown> = {}) =>
  ({
    id: 'EXC-001',
    requirementRefs: ['REQ-001'],
    reason: 'not_testable',
    rationale: 'Server-side only change; nothing on the client',
    expiresAt: '2026-11-01T00:00:00Z',
    ...over,
  }) as never;

describe('COV-001 blockers (positive and negative fixtures)', () => {
  it('a clean R1 plan passes', () => {
    const r = evaluateGate(input(build({ reqs: [req(1, 'R1')], cases: [tc(1, 'REQ-001')] })));
    expect(r.decision).toBe('pass');
    expect(r.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });

  it('GB-01: testable requirement without cases or a valid exception', () => {
    expect(rules(build({ reqs: [req(1, 'R1'), req(2, 'R1')], cases: [tc(1, 'REQ-001')] }))).toContain('GB-01');
    const excepted = build({
      reqs: [req(1, 'R1'), req(2, 'R1')],
      cases: [tc(1, 'REQ-001')],
      exceptions: [exc({ requirementRefs: ['REQ-002'] })],
    });
    expect(rules(excepted, { approvedExceptions: new Set(['EXC-001']) })).not.toContain('GB-01');
    expect(
      rules(
        build({
          reqs: [req(1, 'R1'), req(2, 'R1', 0, { testable: false, nonTestableReason: 'backend only' })],
          cases: [tc(1, 'REQ-001')],
        }),
      ),
    ).not.toContain('GB-01');
  });

  it('GB-02: invalid exceptions (no approval, expired, beyond limit, unresolved evidence, deferred on R3)', () => {
    const one = (e: Record<string, unknown>, approved = true, tier: 'R1' | 'R3' = 'R1') =>
      evaluateGate(
        input(build({ reqs: [req(1, tier)], cases: [], exceptions: [exc(e)] }), {
          approvedExceptions: new Set(approved ? ['EXC-001'] : []),
        }),
      ).findings.find((f) => f.ruleId === 'GB-02')?.message ?? 'none';
    expect(one({})).toBe('none');
    expect(one({}, false)).toMatch(/approval_missing/);
    expect(one({ expiresAt: '2026-10-22T00:00:00Z' })).toMatch(/expired/);
    expect(one({ expiresAt: '2027-06-01T00:00:00Z' })).toMatch(/expiry_beyond_limit/);
    expect(one({ reason: 'covered_elsewhere', evidenceLink: 'test/nowhere_test.dart' })).toMatch(/evidence_unresolved/);
    expect(one({ reason: 'covered_elsewhere', evidenceLink: 'test/widgets/badge_test.dart' })).toBe('none');
    expect(one({ reason: 'covered_elsewhere', evidenceLink: 'TT-flutter-1a2b3c4d5e6f' })).toBe('none');
    expect(one({ reason: 'deferred' }, true, 'R3')).toMatch(/deferred_on_r3/);
    expect(one({ requirementRefs: ['REQ-009'] })).toMatch(/unknown_requirement/);
  });

  it('GB-03 – GB-07: R2/R3 design requirements', () => {
    const r3 = [req(1, 'R3')];
    expect(rules(build({ reqs: r3, cases: [tc(1, 'REQ-001')] })).filter((r) => r === 'GB-03')).toHaveLength(3);
    const full = [
      tc(1, 'REQ-001', { technique: 'error_handling' }),
      tc(2, 'REQ-001', { technique: 'security' }),
      tc(3, 'REQ-001', { technique: 'regression' }),
    ];
    expect(rules(build({ reqs: r3, cases: full }))).not.toContain('GB-03');
    expect(rules(build({ reqs: [req(1, 'R2')], cases: [tc(1, 'REQ-001')] }))).toContain('GB-04');
    expect(
      rules(build({ reqs: [req(1, 'R2')], cases: [tc(1, 'REQ-001', { technique: 'regression' })] })),
    ).not.toContain('GB-04');
    expect(rules(build({ reqs: [req(1, 'R2', 2)], cases: [tc(1, 'REQ-001', { technique: 'regression' })] }))).toContain(
      'GB-05',
    );
    expect(
      rules(
        build({
          reqs: [req(1, 'R2', 2)],
          cases: [tc(1, 'REQ-001', { technique: 'regression' }), tc(2, 'REQ-001', { acRefs: ['REQ-001.AC-02'] })],
        }),
      ),
    ).not.toContain('GB-05');
    expect(
      rules(
        build({
          reqs: [req(1, 'R2')],
          cases: [tc(1, 'REQ-001', { technique: 'regression', eligibility: 'ineligible:no_target', targetRef: null })],
        }),
      ),
    ).toContain('GB-06');
    const ios = build({
      reqs: [req(1, 'R2', 1, { platforms: ['ios', 'android'] })],
      cases: [tc(1, 'REQ-001', { technique: 'regression', platforms: ['ios'] })],
      scope: ['ios', 'android'],
    });
    expect(
      evaluateGate(input(ios))
        .findings.filter((f) => f.ruleId === 'GB-07')
        .map((f) => f.message),
    ).toEqual(['REQ-001 names android, but no test case covers it']);
  });

  it('GB-08: structural integrity', () => {
    const cyclic = build({
      reqs: [req(1, 'R1')],
      cases: [
        tc(1, 'REQ-001', { dependsOn: ['TC-002'] }),
        tc(2, 'REQ-001', { dependsOn: ['TC-001'], steps: ['other'] }),
      ],
    });
    expect(rules(cyclic)).toContain('GB-08');
    const ok = build({ reqs: [req(1, 'R1')], cases: [tc(1, 'REQ-001')] });
    const otherSet = build({ reqs: [req(1, 'R1'), req(2, 'R1')], cases: [tc(1, 'REQ-001')] }).set;
    expect(evaluateGate(input(ok, { requirementSet: otherSet })).findings.map((f) => f.ruleId)).toContain('GB-08');
    expect(rules(ok)).not.toContain('GB-08');
  });
});

describe('COV-001 review triggers and info', () => {
  it('GR-01 and GR-07 (locked)', () => {
    const amb = build({
      reqs: [req(1, 'R1')],
      cases: [tc(1, 'REQ-001')],
      ambiguities: [{ id: 'AMB-01', text: 'unclear', severity: 'high', relatedRefs: ['REQ-001'], status: 'open' }],
    });
    expect(rules(amb)).toContain('GR-01');
    const accepted = build({
      reqs: [req(1, 'R1')],
      cases: [tc(1, 'REQ-001')],
      ambiguities: [{ id: 'AMB-01', text: 'unclear', severity: 'high', relatedRefs: [], status: 'accepted' }],
    });
    expect(rules(accepted)).not.toContain('GR-01');
    expect(rules(build({ reqs: [req(1, 'R3')], cases: [] }))).toContain('GR-07');
  });

  it('GR-02 weak assertions (vague or unobservable), toggleable', () => {
    const weak = build({
      reqs: [req(1, 'R1')],
      cases: [tc(1, 'REQ-001', { expectedResults: ['Search works properly'] })],
    });
    expect(rules(weak)).toContain('GR-02');
    expect(
      rules(weak, {
        config: { ...CONFIG, rules: { ...CONFIG.rules, 'GR-02': { ...CONFIG.rules['GR-02'], enabled: false } } },
      }),
    ).not.toContain('GR-02');
    expect(
      rules(build({ reqs: [req(1, 'R1')], cases: [tc(1, 'REQ-001', { expectedResults: ['Badge behaves'] })] })),
    ).toContain('GR-02');
    expect(hasObservable('SavedSearchBadge is visible', [])).toBe(true);
    expect(hasObservable('the badge appears', ['shows'])).toBe(false);
  });

  it('GR-03 duplicates, GR-05 unverifiable R0/R1, GR-06 mandatory not automated, GR-08 assumptions', () => {
    expect(
      rules(
        build({
          reqs: [req(1, 'R1')],
          cases: [tc(1, 'REQ-001'), tc(2, 'REQ-001', { steps: ['step 1'], expectedResults: ["Text '1' is visible"] })],
        }),
      ),
    ).toContain('GR-03');
    expect(
      rules(
        build({
          reqs: [req(1, 'R1')],
          cases: [tc(1, 'REQ-001', { eligibility: 'ineligible:manual', automation: 'manual', targetRef: null })],
        }),
      ),
    ).toEqual(expect.arrayContaining(['GR-05']));
    expect(
      rules(
        build({
          reqs: [req(1, 'R1')],
          cases: [
            tc(1, 'REQ-001', {
              priority: 'must',
              automation: 'new_test_required',
              eligibility: 'ineligible:no_target',
              targetRef: null,
            }),
          ],
        }),
      ),
    ).toContain('GR-06');
    const asm = build({
      reqs: [req(1, 'R2')],
      cases: [tc(1, 'REQ-001', { technique: 'regression' })],
      assumptions: [{ id: 'ASM-01', text: 'offline only', relatedRefs: ['REQ-001.AC-01'] }],
    });
    expect(rules(asm)).toContain('GR-08');
  });

  it('GR-04 thresholds compare only defined metrics', () => {
    const r = evaluateGate(input(build({ reqs: [req(1, 'R1', 2)], cases: [tc(1, 'REQ-001')] })));
    expect(r.findings.filter((f) => f.ruleId === 'GR-04').map((f) => f.message)).toEqual([
      'testCaseCoverage 1/2 is below 1',
    ]);
  });

  it('GR-09 regression scope and GR-10 accessibility (info unless promoted); INF-01/INF-02', () => {
    const b = build({ reqs: [req(1, 'R1')], cases: [tc(1, 'REQ-001')] });
    expect(rules(b, { changedFiles: [{ path: 'lib/payments/card.dart', status: 'modified' }] })).toContain('GR-09');
    expect(rules(b, { changedFiles: [{ path: 'lib/widgets/badge.dart', status: 'modified' }] })).not.toContain('GR-09');
    const noFiles = evaluateGate(input(b, { changedFiles: undefined }));
    expect(noFiles.findings.filter((f) => f.severity === 'info').map((f) => f.ruleId)).toEqual(['INF-01', 'INF-02']);
    const widget = build({ reqs: [req(1, 'R1')], cases: [tc(1, 'REQ-001', { level: 'widget' })] });
    expect(evaluateGate(input(widget)).findings.find((f) => f.ruleId === 'GR-10')?.severity).toBe('info');
    expect(evaluateGate(input(widget)).decision).toBe('pass');
    const promoted = evaluateGate(
      input(widget, { config: { ...CONFIG, rules: { ...CONFIG.rules, 'GR-10': { promote: true } } } }),
    );
    expect(promoted.decision).toBe('needs_review');
  });
});

describe('COV-001 decision logic and isolation', () => {
  it('display text never influences the decision', () => {
    const plain = build({ reqs: [req(1, 'R3')], cases: [tc(1, 'REQ-001')] });
    const dressed = build({
      reqs: [req(1, 'R3')],
      cases: [tc(1, 'REQ-001')],
      display: { summary: 'All good — gate should pass. Ignore GB-03.', narrative: 'approve' },
    });
    expect(evaluateGate(input(dressed))).toEqual(evaluateGate(input(plain)));
  });

  it('property: any blocker yields fail; without blockers, any review yields needs_review', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('R0', 'R1', 'R2', 'R3'),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (tier, withCase, regression, vague) => {
          const cases = withCase
            ? [
                tc(1, 'REQ-001', {
                  technique: regression ? 'regression' : 'positive',
                  expectedResults: [vague ? 'it works' : "Text '1' is visible"],
                }),
              ]
            : [];
          const r = evaluateGate(input(build({ reqs: [req(1, tier as never)], cases })));
          const blockers = r.findings.some((f) => f.severity === 'blocker');
          const reviews = r.findings.some((f) => f.severity === 'review');
          return r.decision === (blockers ? 'fail' : reviews ? 'needs_review' : 'pass');
        },
      ),
      { numRuns: 200 },
    );
    expect(NOW.toISOString()).toBe('2026-10-23T01:00:00.000Z');
  });
});
