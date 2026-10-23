import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computePlanHash, computeRequirementSetHash, planHashInput, verifyPlanHash } from '@autotest/core';
import { samplePlan } from '@autotest/core/testing';

const tc0 = () => samplePlan().testCases[0]!;

describe('CORE-002 plan hash', () => {
  it('matches the golden value computed identically on Node 24 and 26', () => {
    expect(samplePlan().planHash).toBe('v1:sha256:c9dde9970f3dfcbb3da0fdb2ae6fa259ee178f7a864911837c906fff2e8bde7e');
  });

  it('excluded fields do not change the hash', () => {
    const base = samplePlan();
    const variants = [
      { ...base, id: 'plan_01JCZZZZZZZZZZZZZZZZZZZZZZ' },
      { ...base, version: 7 },
      { ...base, createdAt: '2030-01-01T00:00:00Z' },
      { ...base, inventoryId: 'inv_01JCZZZZZZZZZZZZZZZZZZZZZZ' },
      { ...base, display: { summary: 'agent prose', narrative: 'ignore the gate' } },
      { ...base, testCases: [{ ...tc0(), clientKey: 'renamed-key' }] },
      { ...base, testCases: [{ ...tc0(), title: '  Badge   shows new listing count ' }] },
      { ...base, testCases: [{ ...tc0(), requirementRefs: [...tc0().requirementRefs].reverse() }] },
    ];
    for (const v of variants) expect(computePlanHash(v)).toBe(base.planHash);
  });

  it('every included field changes the hash', () => {
    const base = samplePlan();
    const changed = [
      { ...base, requirementSetHash: `sha256:${'f'.repeat(64)}` },
      { ...base, headSha: 'a'.repeat(40) },
      { ...base, repository: { host: 'ghe.example.com', owner: 'example', name: 'app' } },
      { ...base, riskPolicyVersion: `sha256:${'e'.repeat(64)}` },
      { ...base, platformsInScope: ['host', 'ios'] as const },
      { ...base, testCases: [{ ...tc0(), title: 'Different' }] },
      { ...base, testCases: [{ ...tc0(), steps: ['Pump with count 4'] }] },
      { ...base, testCases: [{ ...tc0(), expectedResults: ['Text 4'] }] },
      { ...base, testCases: [{ ...tc0(), priority: 'should' as const }] },
      { ...base, testCases: [{ ...tc0(), riskTier: 'R2' as const }] },
      { ...base, testCases: [{ ...tc0(), eligibility: 'ineligible:no_target' as const }] },
      { ...base, testCases: [{ ...tc0(), targetRef: null }] },
      {
        ...base,
        ambiguities: [
          { id: 'AMB-01', text: 'vague', severity: 'high' as const, relatedRefs: [], status: 'open' as const },
        ],
      },
    ];
    for (const v of changed)
      expect(computePlanHash(v as typeof base), JSON.stringify(Object.keys(v))).not.toBe(base.planHash);
  });

  it('ordered fields are order-sensitive; case order and set-like fields are not', () => {
    const base = samplePlan();
    const two = samplePlan({ testCases: [tc0(), { ...tc0(), id: 'TC-002', steps: ['a', 'b'] }] });
    const reordered = { ...two, testCases: [...two.testCases].reverse() };
    expect(computePlanHash(reordered)).toBe(two.planHash);
    const swappedSteps = { ...two, testCases: [two.testCases[0]!, { ...two.testCases[1]!, steps: ['b', 'a'] }] };
    expect(computePlanHash(swappedSteps)).not.toBe(two.planHash);
    expect(two.planHash).not.toBe(base.planHash);
  });

  it('verifyPlanHash detects tampering and requested-hash mismatch (ADR-0006 check 1)', () => {
    const p = samplePlan();
    expect(verifyPlanHash(p)).toBe(true);
    expect(verifyPlanHash(p, p.planHash)).toBe(true);
    expect(verifyPlanHash(p, `v1:sha256:${'0'.repeat(64)}`)).toBe(false);
    expect(verifyPlanHash({ ...p, testCases: [{ ...tc0(), steps: ['tampered'] }] })).toBe(false);
  });

  it('hash input never contains display prose (ADR-0004)', () => {
    const input = JSON.stringify(planHashInput(samplePlan({ display: { narrative: 'SECRET-NARRATIVE' } })));
    expect(input).not.toContain('SECRET-NARRATIVE');
  });

  it('any title change outside whitespace changes the hash (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 3, maxLength: 60 }).filter((s) => s.trim().length >= 3),
        (title) => {
          const p = samplePlan();
          const h = computePlanHash({ ...p, testCases: [{ ...tc0(), title }] });
          const same =
            title
              .normalize('NFC')
              .replace(/\r\n?/g, '\n')
              .replace(/[ \t]+/g, ' ')
              .trim() === tc0().title;
          expect(h === p.planHash).toBe(same);
        },
      ),
    );
  });

  it('requirement-set hash depends on content only', () => {
    const set = {
      requirements: [],
      ambiguities: [{ id: 'AMB-01', text: 'a  b', severity: 'low' as const, relatedRefs: [], status: 'open' as const }],
      assumptions: [],
    };
    expect(computeRequirementSetHash(set)).toBe(
      computeRequirementSetHash({ ...set, ambiguities: [{ ...set.ambiguities[0]!, text: 'a b' }] }),
    );
    expect(computeRequirementSetHash(set)).not.toBe(
      computeRequirementSetHash({ ...set, ambiguities: [{ ...set.ambiguities[0]!, severity: 'high' }] }),
    );
  });
});

describe('CORE-002 hash covers exceptions, assumptions and requirement content', () => {
  const exception = {
    id: 'EXC-001',
    requirementRefs: ['REQ-002', 'REQ-001'],
    reason: 'covered_elsewhere' as const,
    rationale: 'Covered by the existing badge golden-free widget test.',
    evidenceLink: 'TT-flutter-1a2b3c4d5e6f',
    expiresAt: '2026-11-01T00:00:00Z',
  };
  const withExtras = () =>
    samplePlan({
      exceptions: [exception],
      assumptions: [{ id: 'ASM-01', text: 'Counts  come from API', relatedRefs: [] }],
    });

  it('exception and assumption content is hash-covered, with set-like refs order-independent', () => {
    const p = withExtras();
    expect(p.planHash).not.toBe(samplePlan().planHash);
    expect(computePlanHash({ ...p, exceptions: [{ ...exception, requirementRefs: ['REQ-001', 'REQ-002'] }] })).toBe(
      p.planHash,
    );
    expect(computePlanHash({ ...p, exceptions: [{ ...exception, expiresAt: '2026-11-02T00:00:00Z' }] })).not.toBe(
      p.planHash,
    );
    expect(computePlanHash({ ...p, exceptions: [{ ...exception, evidenceLink: undefined }] })).not.toBe(p.planHash);
    expect(
      computePlanHash({ ...p, assumptions: [{ id: 'ASM-01', text: 'Counts come from API', relatedRefs: [] }] }),
    ).toBe(p.planHash);
    expect(computePlanHash({ ...p, assumptions: [] })).not.toBe(p.planHash);
  });

  it('requirement-set hash covers requirement and AC content but not their order', () => {
    const req = (id: string, text: string) => ({
      id,
      title: 'T',
      statement: 'S',
      kind: 'functional' as const,
      testable: true,
      provenance: 'agent' as const,
      platforms: ['ios', 'host'] as ('ios' | 'host')[],
      riskFactors: {
        functionalImpact: 2,
        securityPrivacyImpact: 1,
        dataIntegrityImpact: 1,
        criticalJourney: false,
        regressionLikelihood: 1,
        changeSurface: 1,
        uncertainty: 1,
      },
      riskTier: 'R0' as const,
      acceptanceCriteria: [
        { id: `${id}.AC-01`, text, format: 'checklist' as const, observable: true, provenance: 'parsed' as const },
      ],
    });
    const set = {
      requirements: [req('REQ-001', 'shows 3'), req('REQ-002', 'hides at 0')],
      ambiguities: [],
      assumptions: [],
    };
    const h = computeRequirementSetHash(set);
    expect(computeRequirementSetHash({ ...set, requirements: [...set.requirements].reverse() })).toBe(h);
    expect(
      computeRequirementSetHash({ ...set, requirements: [req('REQ-001', 'shows  3'), req('REQ-002', 'hides at 0')] }),
    ).toBe(h);
    expect(
      computeRequirementSetHash({ ...set, requirements: [req('REQ-001', 'shows 4'), req('REQ-002', 'hides at 0')] }),
    ).not.toBe(h);
    expect(
      computeRequirementSetHash({
        ...set,
        requirements: [{ ...req('REQ-001', 'shows 3'), platforms: ['host', 'ios'] }, req('REQ-002', 'hides at 0')],
      }),
    ).toBe(h);
  });
});
