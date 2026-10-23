/**
 * Plan hash and requirement-set hash (CORE-002; data model §Plan hash; ADR-0005).
 *
 * Lives in contracts (moved from @autotest/core for AUTH-003) because the hash definition is part of the contract,
 * and `@autotest/policy`, which may depend only on contracts, recomputes it at authorization time.
 *
 * planHash = "v1:sha256:" + hex(SHA-256(UTF-8(JCS(planHashInput(plan)))))
 * Included: content that a coverage decision or approval is about. Excluded: identity/bookkeeping
 * (id, version, timestamps, schemaVersion, inventoryId, supersedes, clientKey) and untrusted display prose.
 */
import { canonicalize, normalizeText, sha256Hex } from './canonical.ts';
import type { RequirementSet, TestPlan } from './entities.ts';

export const PLAN_HASH_VERSION = 1 as const;
/** Schema version of the plan entity whose fields hashVersion 1 covers. */
export const PLAN_SCHEMA_VERSION = 1 as const;

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sorted = (xs: readonly string[] | undefined): string[] => [...(xs ?? [])].sort();
const texts = (xs: readonly string[]): string[] => xs.map(normalizeText);

/** The exact object hashed for hashVersion 1. Exposed so tests and auditors can inspect what is covered. */
export function planHashInput(plan: TestPlan): Record<string, unknown> {
  return {
    hashVersion: PLAN_HASH_VERSION,
    planSchemaVersion: PLAN_SCHEMA_VERSION,
    requirementSetHash: plan.requirementSetHash,
    repository: {
      host: plan.repository.host,
      owner: plan.repository.owner ?? null,
      name: plan.repository.name ?? null,
      localPath: plan.repository.localPath ?? null,
    },
    headSha: plan.headSha,
    platformsInScope: sorted(plan.platformsInScope),
    riskPolicyVersion: plan.riskPolicyVersion,
    testCases: [...plan.testCases].sort(byId).map((tc) => ({
      id: tc.id,
      title: normalizeText(tc.title),
      requirementRefs: sorted(tc.requirementRefs),
      acRefs: sorted(tc.acRefs),
      level: tc.level,
      technique: tc.technique,
      priority: tc.priority,
      platforms: sorted(tc.platforms),
      preconditions: texts(tc.preconditions),
      steps: texts(tc.steps),
      expectedResults: texts(tc.expectedResults),
      targetRef: tc.targetRef,
      automation: tc.automation,
      eligibility: tc.eligibility,
      riskTier: tc.riskTier,
      dependsOn: sorted(tc.dependsOn),
    })),
    exceptions: [...plan.exceptions].sort(byId).map((e) => ({
      id: e.id,
      requirementRefs: sorted(e.requirementRefs),
      reason: e.reason,
      rationale: normalizeText(e.rationale),
      evidenceLink: e.evidenceLink ?? null,
      expiresAt: e.expiresAt,
    })),
    ambiguities: [...plan.ambiguities].sort(byId).map((a) => ({ id: a.id, severity: a.severity, status: a.status })),
    assumptions: [...plan.assumptions].sort(byId).map((a) => ({ id: a.id, text: normalizeText(a.text) })),
  };
}

/** Canonical plan hash `v1:sha256:<64 hex>`. */
export function computePlanHash(plan: TestPlan): string {
  return `v${PLAN_HASH_VERSION}:sha256:${sha256Hex(canonicalize(planHashInput(plan)))}`;
}

/** True when the stored hash, the recomputed hash and (if given) the requested hash all agree (ADR-0006 §4 check 1). */
export function verifyPlanHash(plan: TestPlan, requestedHash?: string): boolean {
  const recomputed = computePlanHash(plan);
  return plan.planHash === recomputed && (requestedHash === undefined || requestedHash === recomputed);
}

/**
 * Requirement-set hash: content only (requirements, ambiguities, assumptions), so identical extraction input yields
 * an identical hash (FR-010). Excludes id, prContextId, timestamps and schemaVersion.
 */
export function computeRequirementSetHash(
  set: Pick<RequirementSet, 'requirements' | 'ambiguities' | 'assumptions'>,
): string {
  const input = {
    requirements: [...set.requirements].sort(byId).map((r) => ({
      ...r,
      title: normalizeText(r.title),
      statement: normalizeText(r.statement),
      platforms: sorted(r.platforms),
      acceptanceCriteria: [...r.acceptanceCriteria].sort(byId).map((ac) => ({ ...ac, text: normalizeText(ac.text) })),
    })),
    ambiguities: [...set.ambiguities]
      .sort(byId)
      .map((a) => ({ ...a, text: normalizeText(a.text), relatedRefs: sorted(a.relatedRefs) })),
    assumptions: [...set.assumptions]
      .sort(byId)
      .map((a) => ({ ...a, text: normalizeText(a.text), relatedRefs: sorted(a.relatedRefs) })),
  };
  return `sha256:${sha256Hex(canonicalize(input))}`;
}
