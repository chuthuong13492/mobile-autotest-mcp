/**
 * Plan normalization (PLN-003; TL-05; FR-011, FR-012, FR-014, FR-015; ADR-0004, ADR-0005).
 *
 * Validates the agent's draft against the requirement set and the inventory snapshot, then builds the immutable
 * plan: normalized text, TC ids (stable by `clientKey` across versions of one plan), targets resolved from
 * `targetPath` to inventory TestTarget ids (paths are canonicalized; anything escaping or unknown stays unresolved),
 * per-case risk (the highest tier of the referenced requirements) and eligibility, exceptions, and the plan hash.
 * When the hash equals the base version's, the base version is returned unchanged (idempotency). Nothing here
 * judges coverage sufficiency — that is the gate (TL-06).
 */
import {
  computePlanHash,
  formatSeqId,
  nextSeqId,
  normalizeRelPath,
  normalizeText,
  TestPlan,
  type CoverageException,
  type Platform,
  type RepositoryIdentity,
  type RequirementSet,
  type TestCase,
  type TestInventory,
  type TestTarget,
  type ToolInput,
} from '@autotest/core';
import { eligibility, type EligibilityContext } from '../eligibility.ts';
import { maxTier } from '../risk.ts';

export type PlanDraft = ToolInput<'generate_test_plan'>['draft'];

export interface NormalizeInput {
  readonly draft: PlanDraft;
  readonly platformsInScope: readonly Platform[];
  readonly requirementSet: RequirementSet;
  readonly inventory: TestInventory;
  /** Latest version of `basePlanId`, when revising a plan. */
  readonly basePlan?: TestPlan;
  readonly repository: RepositoryIdentity;
  readonly headSha: string | null;
  readonly riskPolicyVersion: string;
  /** Eligibility context for a resolved target (capabilities of its adapter, host, policy). */
  readonly eligibilityContext: (target: TestTarget | undefined) => EligibilityContext;
  readonly now: Date;
  readonly exceptionMaxDays: number;
  readonly newPlanId: () => string;
}

export interface Issue {
  readonly pointer: string;
  readonly message: string;
}

export type NormalizeResult =
  | {
      readonly ok: true;
      readonly plan: TestPlan;
      /** True when the draft normalized to the base version's hash and that version is returned. */
      readonly reused: boolean;
      readonly unresolvedTargets: { clientKey: string; targetPath: string; reason: string }[];
      readonly warnings: string[];
    }
  | { readonly ok: false; readonly issues: Issue[] };

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const texts = (xs: readonly string[]) => xs.map(normalizeText);

export function normalizePlan(input: NormalizeInput): NormalizeResult {
  const { draft, requirementSet: set } = input;
  const issues: Issue[] = [];
  const warnings: string[] = [];
  const reqs = new Map(set.requirements.map((r) => [r.id, r]));
  const acIds = new Set(set.requirements.flatMap((r) => r.acceptanceCriteria.map((a) => a.id)));

  // ---- references and keys
  const keys = new Map<string, number>();
  draft.testCases.forEach((c, i) => {
    const at = `/draft/testCases/${i}`;
    if (keys.has(c.clientKey)) issues.push({ pointer: `${at}/clientKey`, message: 'duplicate clientKey' });
    keys.set(c.clientKey, i);
    c.requirementRefs.forEach((r, j) => {
      if (!reqs.has(r)) issues.push({ pointer: `${at}/requirementRefs/${j}`, message: `unknown requirement ${r}` });
    });
    c.acRefs.forEach((a, j) => {
      if (!acIds.has(a)) issues.push({ pointer: `${at}/acRefs/${j}`, message: `unknown acceptance criterion ${a}` });
      else if (!c.requirementRefs.some((r) => a.startsWith(`${r}.`)))
        issues.push({
          pointer: `${at}/acRefs/${j}`,
          message: `${a} belongs to a requirement the case does not reference`,
        });
    });
    const outOfScope = c.platforms.filter((p) => !input.platformsInScope.includes(p));
    if (outOfScope.length === c.platforms.length)
      issues.push({ pointer: `${at}/platforms`, message: 'no platform of this case is in scope' });
    else if (outOfScope.length)
      warnings.push(`${c.clientKey}: platforms outside scope ignored (${outOfScope.join(', ')})`);
  });
  draft.testCases.forEach((c, i) => {
    c.dependsOnKeys.forEach((k, j) => {
      if (!keys.has(k))
        issues.push({ pointer: `/draft/testCases/${i}/dependsOnKeys/${j}`, message: `unknown clientKey ${k}` });
    });
  });
  const cycle = findCycle(
    draft.testCases.map((c) => ({ key: c.clientKey, deps: c.dependsOnKeys.filter((k) => keys.has(k)) })),
  );
  if (cycle)
    issues.push({
      pointer: `/draft/testCases/${keys.get(cycle)!}/dependsOnKeys`,
      message: 'dependsOnKeys must be acyclic',
    });

  // ---- exceptions
  const maxExpiry = input.now.getTime() + input.exceptionMaxDays * 86_400_000;
  draft.exceptions.forEach((e, i) => {
    const at = `/draft/exceptions/${i}`;
    e.requirementRefs.forEach((r, j) => {
      if (!reqs.has(r)) issues.push({ pointer: `${at}/requirementRefs/${j}`, message: `unknown requirement ${r}` });
    });
    const exp = Date.parse(e.expiresAt);
    if (!(exp > input.now.getTime()))
      issues.push({ pointer: `${at}/expiresAt`, message: 'expiresAt must be in the future' });
    else if (exp > maxExpiry)
      issues.push({ pointer: `${at}/expiresAt`, message: `expiresAt must be within ${input.exceptionMaxDays} days` });
    if (e.reason === 'covered_elsewhere' && !e.evidenceLink)
      issues.push({ pointer: `${at}/evidenceLink`, message: 'covered_elsewhere requires evidenceLink' });
  });
  if (issues.length) return { ok: false, issues: issues.slice(0, 50) };

  // ---- ids (stable by clientKey across versions)
  const baseIds = new Map(
    (input.basePlan?.testCases ?? []).filter((c) => c.clientKey).map((c) => [c.clientKey!, c.id]),
  );
  const used = new Set<string>(baseIds.values());
  const idOf = new Map<string, string>();
  for (const c of draft.testCases) {
    const reused = baseIds.get(c.clientKey);
    if (reused) idOf.set(c.clientKey, reused);
  }
  for (const c of draft.testCases) {
    if (idOf.has(c.clientKey)) continue;
    const id = nextSeqId('TC', used);
    used.add(id);
    idOf.set(c.clientKey, id);
  }

  // ---- targets, risk, eligibility
  // A file can have one target per platform (FL-006: integration_test on iOS and on Android): the case's first
  // in-scope platform picks among them; otherwise the first target of the file.
  const byPath = new Map<string, TestTarget[]>();
  for (const t of input.inventory.targets) byPath.set(t.path, [...(byPath.get(t.path) ?? []), t]);
  const pickTarget = (rel: string, platforms: readonly string[]) => {
    const all = byPath.get(rel);
    return all?.find((t) => t.platforms.some((p) => platforms.includes(p))) ?? all?.[0];
  };
  const unresolvedTargets: { clientKey: string; targetPath: string; reason: string }[] = [];
  const testCases: TestCase[] = draft.testCases.map((c) => {
    let target: TestTarget | undefined;
    if (c.targetPath !== undefined) {
      let rel: string | undefined;
      try {
        rel = normalizeRelPath(c.targetPath);
      } catch {
        rel = undefined;
      }
      target =
        rel === undefined
          ? undefined
          : pickTarget(
              rel,
              c.platforms.filter((p) => input.platformsInScope.includes(p)),
            );
      if (!target)
        unresolvedTargets.push({
          clientKey: c.clientKey,
          targetPath: c.targetPath.slice(0, 1024),
          reason: rel === undefined ? 'invalid_path' : 'not_in_inventory',
        });
    } else if (c.automation === 'existing_test')
      unresolvedTargets.push({ clientKey: c.clientKey, targetPath: '', reason: 'missing_target_path' });
    if (c.targetSelector !== undefined)
      warnings.push(`${c.clientKey}: targetSelector is not used in this version (file-level selection)`);
    const platforms = c.platforms.filter((p) => input.platformsInScope.includes(p));
    const effectiveTarget = c.automation === 'existing_test' ? target : undefined;
    return {
      id: idOf.get(c.clientKey)!,
      clientKey: c.clientKey,
      title: normalizeText(c.title).slice(0, 200),
      requirementRefs: [...new Set(c.requirementRefs)],
      acRefs: [...new Set(c.acRefs)],
      level: c.level,
      technique: c.technique,
      priority: c.priority,
      platforms,
      preconditions: texts(c.preconditions),
      steps: texts(c.steps),
      expectedResults: texts(c.expectedResults),
      targetRef: effectiveTarget?.id ?? null,
      automation: c.automation,
      eligibility: eligibility(
        { automation: c.automation, platforms },
        effectiveTarget,
        input.eligibilityContext(effectiveTarget),
      ),
      riskTier: maxTier(c.requirementRefs.map((r) => reqs.get(r)!.riskTier)),
      ...(c.dependsOnKeys.length ? { dependsOn: [...new Set(c.dependsOnKeys.map((k) => idOf.get(k)!))] } : {}),
    };
  });

  const exceptions: CoverageException[] = draft.exceptions.map((e, i) => ({
    id: formatSeqId('EXC', i + 1),
    requirementRefs: [...new Set(e.requirementRefs)],
    reason: e.reason,
    rationale: normalizeText(e.rationale),
    ...(e.evidenceLink ? { evidenceLink: e.evidenceLink } : {}),
    expiresAt: e.expiresAt,
  }));

  const base = input.basePlan;
  const candidate = {
    id: base?.id ?? input.newPlanId(),
    version: base ? base.version + 1 : 1,
    schemaVersion: 1 as const,
    createdAt: iso(input.now),
    planHash: '',
    hashVersion: 1 as const,
    requirementSetId: set.id,
    requirementSetHash: set.requirementSetHash,
    inventoryId: input.inventory.id,
    repository: input.repository,
    headSha: input.headSha,
    riskPolicyVersion: input.riskPolicyVersion,
    platformsInScope: [...new Set(input.platformsInScope)],
    testCases,
    exceptions,
    ambiguities: set.ambiguities,
    assumptions: set.assumptions,
    ...(draft.display ? { display: draft.display } : {}),
    ...(base ? { supersedes: { planId: base.id, version: base.version, planHash: base.planHash } } : {}),
  };
  const planHash = computePlanHash(candidate as unknown as TestPlan);
  if (base && base.planHash === planHash) return { ok: true, plan: base, reused: true, unresolvedTargets, warnings };
  const plan = TestPlan.parse({ ...candidate, planHash });
  return { ok: true, plan, reused: false, unresolvedTargets, warnings };
}

/** Returns a clientKey on a dependency cycle, or undefined. */
function findCycle(nodes: readonly { key: string; deps: readonly string[] }[]): string | undefined {
  const deps = new Map(nodes.map((n) => [n.key, n.deps]));
  const state = new Map<string, 1 | 2>();
  const visit = (k: string): string | undefined => {
    if (state.get(k) === 2) return undefined;
    if (state.get(k) === 1) return k;
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    state.set(k, 2);
    return undefined;
  };
  for (const n of nodes) {
    const c = visit(n.key);
    if (c) return c;
  }
  return undefined;
}
