/** Docs-sync checks for pure packages that may not read files themselves (dependency rule `adapters-no-side-effects`). */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RISK_POLICY_V1 } from '@autotest/planning';
import { loadPolicyConfig } from '@autotest/policy';

describe('PLN-004 risk policy v1 docs-sync', () => {
  const doc = fs.readFileSync(path.resolve(import.meta.dirname, '../../../docs/test-planning-and-coverage.md'), 'utf8');

  it('thresholds match the canonical computation block', () => {
    const m = /R0: S ≤ (\d+)\s+R1: \d+ ≤ S ≤ (\d+)\s+R2: \d+ ≤ S ≤ (\d+)\s+R3: S ≥ (\d+)/.exec(doc)!;
    expect(RISK_POLICY_V1.thresholds).toEqual({ r0Max: Number(m[1]), r1Max: Number(m[2]), r2Max: Number(m[3]) });
    expect(Number(m[4])).toBe(RISK_POLICY_V1.thresholds.r2Max + 1);
  });

  it('default factors match the doc and the policy-config defaults', () => {
    const d =
      /these conservative values are used: FI (\d), SPI (\d), DII (\d), CJ (false|true), RL (\d), CS (\d), U (\d), PS (\d)/.exec(
        doc,
      )!;
    const fromDoc = {
      functionalImpact: Number(d[1]),
      securityPrivacyImpact: Number(d[2]),
      dataIntegrityImpact: Number(d[3]),
      criticalJourney: d[4] === 'true',
      regressionLikelihood: Number(d[5]),
      changeSurface: Number(d[6]),
      uncertainty: Number(d[7]),
      platformSpecificity: Number(d[8]),
    };
    expect(RISK_POLICY_V1.defaultFactors).toEqual(fromDoc);
    const cfg = loadPolicyConfig('version: 1\n');
    if (!cfg.ok) throw new Error('policy');
    expect({
      thresholds: cfg.policy.config.risk.thresholds,
      defaultFactors: cfg.policy.config.risk.defaultFactors,
    }).toEqual(RISK_POLICY_V1);
  });
});
