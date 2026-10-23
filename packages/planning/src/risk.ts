/**
 * Risk model (PLN-004; FR-013; test-planning §Risk model).
 *
 *   Impact      I = max(FI, SPI, DII, CJ ? 3 : 1)
 *   Likelihood  L = min(4, RL + (U − 1) + (PS − 1))
 *   Score       S = I × L × CS                     (1 … 48)
 *   Tier        R0: S ≤ r0Max   R1: ≤ r1Max   R2: ≤ r2Max   R3: above
 *   Overrides   SPI = 4 or DII = 4 → at least R3;  SPI = 3 or DII = 3 → at least R2;  CJ → at least R2
 *
 * Missing factors take the policy defaults (conservative: R2 under policy v1), so absent information never lowers
 * risk. The result carries its rationale: the effective factors, the intermediate values and the rule applied.
 */
import type { RiskFactors, RiskTier } from '@autotest/core';

/** The `risk` section of the user policy (thresholds and defaults); `riskPolicyVersion` digests it. */
export interface RiskPolicy {
  readonly thresholds: { readonly r0Max: number; readonly r1Max: number; readonly r2Max: number };
  readonly defaultFactors: Required<RiskFactors>;
}

export const RISK_POLICY_V1: RiskPolicy = {
  thresholds: { r0Max: 4, r1Max: 12, r2Max: 24 },
  defaultFactors: {
    functionalImpact: 3,
    securityPrivacyImpact: 2,
    dataIntegrityImpact: 2,
    criticalJourney: false,
    regressionLikelihood: 3,
    changeSurface: 2,
    uncertainty: 2,
    platformSpecificity: 1,
  },
};

export interface RiskAssessment {
  readonly tier: RiskTier;
  readonly factors: Required<RiskFactors>;
  readonly impact: number;
  readonly likelihood: number;
  readonly score: number;
  /** `score` when the thresholds decided, otherwise the override that raised the tier. */
  readonly rule: 'score' | 'override:spi_dii_4' | 'override:spi_dii_3' | 'override:critical_journey';
  readonly defaultsApplied: boolean;
}

const ORDER: readonly RiskTier[] = ['R0', 'R1', 'R2', 'R3'];
const atLeast = (t: RiskTier, floor: RiskTier): RiskTier => (ORDER.indexOf(t) >= ORDER.indexOf(floor) ? t : floor);

export function maxTier(tiers: readonly RiskTier[]): RiskTier {
  return tiers.reduce<RiskTier>((m, t) => atLeast(m, t), 'R0');
}

export function assessRisk(factors: RiskFactors | undefined, policy: RiskPolicy = RISK_POLICY_V1): RiskAssessment {
  const f: Required<RiskFactors> = factors
    ? { ...factors, platformSpecificity: factors.platformSpecificity ?? policy.defaultFactors.platformSpecificity }
    : { ...policy.defaultFactors };
  const impact = Math.max(
    f.functionalImpact,
    f.securityPrivacyImpact,
    f.dataIntegrityImpact,
    f.criticalJourney ? 3 : 1,
  );
  const likelihood = Math.min(4, f.regressionLikelihood + (f.uncertainty - 1) + (f.platformSpecificity - 1));
  const score = impact * likelihood * f.changeSurface;
  const t = policy.thresholds;
  const byScore: RiskTier = score <= t.r0Max ? 'R0' : score <= t.r1Max ? 'R1' : score <= t.r2Max ? 'R2' : 'R3';
  let tier = byScore;
  let rule: RiskAssessment['rule'] = 'score';
  const raise = (floor: RiskTier, why: RiskAssessment['rule']) => {
    if (ORDER.indexOf(floor) > ORDER.indexOf(tier)) {
      tier = floor;
      rule = why;
    }
  };
  if (f.securityPrivacyImpact === 4 || f.dataIntegrityImpact === 4) raise('R3', 'override:spi_dii_4');
  if (f.securityPrivacyImpact === 3 || f.dataIntegrityImpact === 3) raise('R2', 'override:spi_dii_3');
  if (f.criticalJourney) raise('R2', 'override:critical_journey');
  return { tier, factors: f, impact, likelihood, score, rule, defaultsApplied: factors === undefined };
}
