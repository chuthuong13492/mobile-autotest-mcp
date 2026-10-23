/**
 * Exception validation (COV-003; FR-020; test-planning §Exception and expiry policy; GB-02).
 *
 * An exception counts only when all hold: its rationale has at least 20 characters, a human approved it at the
 * required assurance (verified by the caller through policy and passed in as `approvedExceptions`, so the agent can
 * never self-approve), it has not expired and does not exceed the policy's maximum duration, a `covered_elsewhere`
 * link resolves to an existing inventory TestTarget, it is not `deferred` on an R3 requirement, and every
 * requirement it names exists. Anything else triggers GB-02 and the exception covers nothing.
 */
import type { CoverageException, RequirementSet, TestTarget } from '@autotest/core';
import type { ExceptionCheck } from './types.ts';

export interface ExceptionContext {
  readonly requirementSet: RequirementSet;
  readonly targets: readonly TestTarget[];
  readonly approvedExceptions: ReadonlySet<string>;
  readonly now: Date;
  readonly exceptionMaxDays: number;
}

/** The TestTarget an evidence link names: a TT id, or a workspace-relative path of an inventory target. */
export function resolveEvidenceLink(link: string | undefined, targets: readonly TestTarget[]): TestTarget | undefined {
  if (!link) return undefined;
  const ref = link.trim();
  return targets.find((t) => t.id === ref || t.path === ref.replace(/^\.\//, ''));
}

export function checkException(e: CoverageException, ctx: ExceptionContext): ExceptionCheck {
  const problems: ExceptionCheck['problems'][number][] = [];
  const reqs = new Map(ctx.requirementSet.requirements.map((r) => [r.id, r]));
  if (e.rationale.trim().length < 20) problems.push('rationale_too_short');
  if (!ctx.approvedExceptions.has(e.id)) problems.push('approval_missing');
  const exp = Date.parse(e.expiresAt);
  if (!(exp > ctx.now.getTime())) problems.push('expired');
  else if (exp > ctx.now.getTime() + ctx.exceptionMaxDays * 86_400_000) problems.push('expiry_beyond_limit');
  const evidence = e.reason === 'covered_elsewhere' ? resolveEvidenceLink(e.evidenceLink, ctx.targets) : undefined;
  if (e.reason === 'covered_elsewhere' && !evidence) problems.push('evidence_unresolved');
  if (e.requirementRefs.some((r) => !reqs.has(r))) problems.push('unknown_requirement');
  if (e.reason === 'deferred' && e.requirementRefs.some((r) => reqs.get(r)?.riskTier === 'R3'))
    problems.push('deferred_on_r3');
  return {
    exception: e,
    valid: problems.length === 0,
    ...(evidence ? { evidenceTargetId: evidence.id } : {}),
    problems,
  };
}

export function checkExceptions(exceptions: readonly CoverageException[], ctx: ExceptionContext): ExceptionCheck[] {
  return exceptions.map((e) => checkException(e, ctx));
}
