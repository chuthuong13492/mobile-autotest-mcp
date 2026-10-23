/**
 * Blocker rules GB-01 – GB-08 (COV-001; test-planning §Blockers). Blockers cannot be disabled; any blocker makes
 * the decision `fail`.
 */
import type { RequirementSet, TestPlan } from '@autotest/core';
import type { ExceptionCheck, Finding } from '../types.ts';

const R2PLUS = new Set(['R2', 'R3']);
const f = (ruleId: string, message: string, refs: readonly string[]): Finding => ({
  ruleId,
  severity: 'blocker',
  message: message.slice(0, 500),
  refs: [...refs].slice(0, 20),
});

export function blockerFindings(plan: TestPlan, set: RequirementSet, exceptions: readonly ExceptionCheck[]): Finding[] {
  const out: Finding[] = [];
  const casesOf = (id: string) => plan.testCases.filter((c) => c.requirementRefs.includes(id));
  const excepted = (id: string) => exceptions.some((e) => e.valid && e.exception.requirementRefs.includes(id));

  for (const r of set.requirements) {
    const cases = casesOf(r.id);
    // GB-01: a testable requirement with neither a case nor a valid exception.
    if (r.testable && cases.length === 0 && !excepted(r.id))
      out.push(f('GB-01', `${r.id} has no test case and no valid exception`, [r.id]));
    if (!r.testable || !R2PLUS.has(r.riskTier)) continue;
    const has = (...techniques: string[]) => cases.some((c) => techniques.includes(c.technique));
    // GB-03: R3 needs error handling, plus security / data-integrity cases when those impacts are high.
    if (r.riskTier === 'R3') {
      if (!has('error_handling')) out.push(f('GB-03', `${r.id} (R3) has no error_handling case`, [r.id]));
      if (r.riskFactors.securityPrivacyImpact >= 3 && !has('security'))
        out.push(f('GB-03', `${r.id} (R3, security/privacy impact ≥3) has no security case`, [r.id]));
      if (r.riskFactors.dataIntegrityImpact >= 3 && !has('boundary', 'error_handling'))
        out.push(f('GB-03', `${r.id} (R3, data-integrity impact ≥3) has no boundary or error_handling case`, [r.id]));
    }
    // GB-04: R2+ needs a regression case.
    if (!has('regression')) out.push(f('GB-04', `${r.id} (${r.riskTier}) has no regression case`, [r.id]));
    // GB-05: every AC of an R2+ requirement needs a case.
    for (const ac of r.acceptanceCriteria) {
      if (!plan.testCases.some((c) => c.acRefs.includes(ac.id)))
        out.push(f('GB-05', `${ac.id} of ${r.riskTier} requirement ${r.id} has no test case`, [ac.id]));
    }
    // GB-06: R2+ needs an eligible case or a valid exception.
    if (!cases.some((c) => c.eligibility === 'eligible') && !excepted(r.id))
      out.push(f('GB-06', `${r.id} (${r.riskTier}) has no eligible test case and no valid exception`, [r.id]));
    // GB-07: every in-scope platform the requirement names must be covered by a case.
    for (const p of r.platforms.filter((x) => plan.platformsInScope.includes(x))) {
      if (!cases.some((c) => c.platforms.includes(p)))
        out.push(f('GB-07', `${r.id} names ${p}, but no test case covers it`, [r.id]));
    }
  }

  // GB-02: every invalid exception.
  for (const e of exceptions) {
    if (!e.valid)
      out.push(
        f('GB-02', `${e.exception.id} is not valid: ${e.problems.join(', ')}`, [
          e.exception.id,
          ...e.exception.requirementRefs,
        ]),
      );
  }

  out.push(...integrityFindings(plan, set));
  return out;
}

/** GB-08: dangling references, duplicate ids, cyclic `dependsOn`, and a plan bound to another requirement set. */
export function integrityFindings(plan: TestPlan, set: RequirementSet): Finding[] {
  const out: Finding[] = [];
  const reqIds = new Set(set.requirements.map((r) => r.id));
  const acIds = new Set(set.requirements.flatMap((r) => r.acceptanceCriteria.map((a) => a.id)));
  const tcIds = new Set<string>();
  if (plan.requirementSetHash !== set.requirementSetHash || plan.requirementSetId !== set.id)
    out.push(f('GB-08', 'the plan is bound to a different requirement set', [plan.requirementSetId]));
  for (const c of plan.testCases) {
    if (tcIds.has(c.id)) out.push(f('GB-08', `duplicate test case id ${c.id}`, [c.id]));
    tcIds.add(c.id);
    for (const r of c.requirementRefs)
      if (!reqIds.has(r)) out.push(f('GB-08', `${c.id} references unknown ${r}`, [c.id, r]));
    for (const a of c.acRefs) if (!acIds.has(a)) out.push(f('GB-08', `${c.id} references unknown ${a}`, [c.id, a]));
  }
  for (const c of plan.testCases)
    for (const d of c.dependsOn ?? [])
      if (!tcIds.has(d)) out.push(f('GB-08', `${c.id} depends on unknown ${d}`, [c.id, d]));
  const excIds = new Set<string>();
  for (const e of plan.exceptions) {
    if (excIds.has(e.id)) out.push(f('GB-08', `duplicate exception id ${e.id}`, [e.id]));
    excIds.add(e.id);
  }
  const cyclic = cycleMember(plan);
  if (cyclic) out.push(f('GB-08', `dependsOn forms a cycle through ${cyclic}`, [cyclic]));
  return out;
}

function cycleMember(plan: TestPlan): string | undefined {
  const deps = new Map(plan.testCases.map((c) => [c.id, c.dependsOn ?? []]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): string | undefined => {
    const s = state.get(id);
    if (s === 2) return undefined;
    if (s === 1) return id;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) {
      const hit = visit(d);
      if (hit) return hit;
    }
    state.set(id, 2);
    return undefined;
  };
  for (const c of plan.testCases) {
    const hit = visit(c.id);
    if (hit) return hit;
  }
  return undefined;
}
