import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RiskFactors } from '@autotest/core';
import { assessRisk, maxTier } from '@autotest/planning';

const low: RiskFactors = {
  functionalImpact: 1,
  securityPrivacyImpact: 1,
  dataIntegrityImpact: 1,
  criticalJourney: false,
  regressionLikelihood: 1,
  changeSurface: 1,
  uncertainty: 1,
  platformSpecificity: 1,
};
const ORDER = ['R0', 'R1', 'R2', 'R3'];

describe('PLN-004 risk model', () => {
  it('computes the documented examples', () => {
    expect(assessRisk({ ...low, functionalImpact: 3, regressionLikelihood: 2, changeSurface: 2 })).toMatchObject({
      tier: 'R1',
      impact: 3,
      likelihood: 2,
      score: 12,
      rule: 'score',
    });
    expect(assessRisk(undefined)).toMatchObject({ tier: 'R2', score: 24, defaultsApplied: true });
    expect(assessRisk(low)).toMatchObject({ tier: 'R0', score: 1 });
    expect(assessRisk({ ...low, functionalImpact: 4, regressionLikelihood: 4, changeSurface: 3 })).toMatchObject({
      tier: 'R3',
      score: 48,
    });
  });

  it('applies the overrides whatever the arithmetic says', () => {
    expect(assessRisk({ ...low, securityPrivacyImpact: 4 })).toMatchObject({ tier: 'R3', rule: 'override:spi_dii_4' });
    expect(assessRisk({ ...low, dataIntegrityImpact: 4 })).toMatchObject({ tier: 'R3' });
    expect(assessRisk({ ...low, dataIntegrityImpact: 3 })).toMatchObject({ tier: 'R2', rule: 'override:spi_dii_3' });
    expect(assessRisk({ ...low, criticalJourney: true })).toMatchObject({
      tier: 'R2',
      rule: 'override:critical_journey',
      impact: 3,
    });
    expect(assessRisk({ ...low, platformSpecificity: undefined }).factors.platformSpecificity).toBe(1);
  });

  it('property: raising any factor never lowers the tier', () => {
    const factors = fc.record({
      functionalImpact: fc.integer({ min: 1, max: 4 }),
      securityPrivacyImpact: fc.integer({ min: 1, max: 4 }),
      dataIntegrityImpact: fc.integer({ min: 1, max: 4 }),
      criticalJourney: fc.boolean(),
      regressionLikelihood: fc.integer({ min: 1, max: 4 }),
      changeSurface: fc.integer({ min: 1, max: 3 }),
      uncertainty: fc.integer({ min: 1, max: 3 }),
      platformSpecificity: fc.integer({ min: 1, max: 2 }),
    });
    const max: Record<string, number | boolean> = {
      functionalImpact: 4,
      securityPrivacyImpact: 4,
      dataIntegrityImpact: 4,
      criticalJourney: true,
      regressionLikelihood: 4,
      changeSurface: 3,
      uncertainty: 3,
      platformSpecificity: 2,
    };
    fc.assert(
      fc.property(factors, fc.constantFrom(...Object.keys(max)), (f, key) => {
        const v = f[key as keyof RiskFactors];
        const raised = { ...f, [key]: typeof v === 'boolean' ? true : Math.min((v as number) + 1, max[key] as number) };
        return ORDER.indexOf(assessRisk(raised).tier) >= ORDER.indexOf(assessRisk(f).tier);
      }),
      { numRuns: 1000 },
    );
    expect(maxTier(['R1', 'R3', 'R0'])).toBe('R3');
    expect(maxTier([])).toBe('R0');
  });
});
