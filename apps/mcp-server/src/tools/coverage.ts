/**
 * TL-06 `validate_test_coverage` use case (COV-004; FR-017; ADR-0005; T-18).
 *
 * The requested plan hash must match a stored version of the plan, and that version's stored hash must equal its
 * recomputed hash (plan snapshots are verified on load). The gate runs on persisted entities only; exception
 * approvals are looked up by their scope digest (bound to the plan hash and the exception's content) and verified
 * through policy, so an agent cannot approve an exception. The gate is pure and re-evaluated on each call, because
 * exception approvals and expiry are inputs the bindings (plan hash, requirement-set hash, gate policy version) do
 * not capture; the stored decision for those bindings is returned when the result is identical, and a new decision
 * is recorded when it differs (for example after a human approves an exception). `current` is false when a newer
 * plan version exists. Findings are paged with HMAC cursors drawn from the stored decision.
 */
import { canonicalize, paginate, PortError, toolError, type CoverageDecision, type TestPlan } from '@autotest/core';
import { evaluateGate } from '@autotest/coverage-gate';
import {
  coverageExceptionScope,
  NO_AL3,
  selectApproval,
  type PolicyEnvironment,
  type PolicyLoadResult,
} from '@autotest/policy';
import { fail, ok, type UseCases, type WorkflowPorts } from '@autotest/workflow';

export interface CoverageDeps {
  readonly ports: WorkflowPorts;
  readonly policy: PolicyLoadResult;
  readonly serverEnvironment: { readonly id: string; readonly kind: PolicyEnvironment };
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const FINDINGS_PAGE = 100;

export function coverageUseCases(deps: CoverageDeps): Pick<UseCases, 'validate_test_coverage'> {
  const { ports } = deps;
  return {
    async validate_test_coverage(input) {
      if (!deps.policy.ok)
        return fail(
          toolError('E_POLICY_UNAVAILABLE', 'the user policy is missing or invalid', [
            'Fix ~/.autotest/config.yaml, then run `autotest doctor`.',
          ]),
        );
      const policy = deps.policy.policy;
      let plan: TestPlan | undefined;
      let latest: TestPlan | undefined;
      try {
        latest = await ports.plans.get(input.planId);
        if (!latest) return fail(toolError('E_PLAN_NOT_FOUND', 'plan not found', ['Call generate_test_plan first']));
        const byHash = await ports.plans.getByHash(input.planHash);
        plan = byHash && byHash.id === input.planId ? byHash : undefined;
      } catch (e) {
        if (e instanceof PortError && e.code === 'integrity')
          return fail(
            toolError('E_PLAN_HASH_MISMATCH', 'the stored plan does not match its hash', ['Regenerate the plan']),
          );
        throw e;
      }
      if (!plan)
        return fail(
          toolError('E_PLAN_HASH_MISMATCH', 'planHash does not match any version of this plan', [
            'Use the planHash returned by generate_test_plan',
          ]),
        );

      const set = await ports.requirements.get(plan.requirementSetId);
      if (!set) return fail(toolError('E_PLAN_NOT_FOUND', 'the plan’s requirement set was not found', []));
      const binding = {
        planHash: plan.planHash,
        requirementSetHash: set.requirementSetHash,
        gatePolicyVersion: policy.gatePolicyVersion,
      };

      // The gate is re-evaluated on every call: exception approvals and expiry are inputs that the three bindings do
      // not capture. The stored decision for the bindings is reused only when the result is identical.
      const inventory = await ports.inventories.get(plan.inventoryId);
      const context = await ports.prContexts.get(set.prContextId);
      const now = ports.clock.now();
      const approvedExceptions = new Set<string>();
      for (const e of plan.exceptions) {
        const scope = coverageExceptionScope({ planHash: plan.planHash, exception: e });
        const sel = selectApproval(
          await ports.approvals.listByScopeDigest(scope.digest),
          {
            scope,
            planHash: plan.planHash,
            environment: deps.serverEnvironment.id,
            policyVersion: policy.policyVersion,
          },
          {
            now,
            environmentKind: deps.serverEnvironment.kind,
            overrides: policy.config.approvals.minAssurance,
            al3: NO_AL3,
          },
        );
        if (sel.approval) approvedExceptions.add(e.id);
      }
      const result = evaluateGate({
        plan,
        requirementSet: set,
        config: policy.config.coverageGate,
        targets: inventory?.targets ?? [],
        approvedExceptions,
        ...(context?.changedFiles && !context.limitations.some((l) => l.code === 'diff_unavailable')
          ? { changedFiles: context.changedFiles }
          : {}),
        now,
      });
      const existing = await ports.decisions.findCurrent(binding);
      const outcome = {
        decision: result.decision,
        findings: result.findings,
        metrics: result.metrics,
        requirementStatus: result.requirementStatus,
      };
      let decision: CoverageDecision;
      if (
        existing &&
        canonicalize({
          decision: existing.decision,
          findings: existing.findings,
          metrics: existing.metrics,
          requirementStatus: existing.requirementStatus,
        }) === canonicalize(outcome)
      ) {
        decision = existing;
      } else {
        decision = {
          id: ports.ids.newId('cov'),
          schemaVersion: 1,
          planId: plan.id,
          ...binding,
          ...outcome,
          evaluatedAt: iso(now),
        } satisfies CoverageDecision;
        await ports.decisions.put(decision);
        await ports.audit.append({
          ts: iso(now),
          actor: 'agent',
          kind: 'coverage.decision',
          subjectRefs: [plan.id, decision.id],
          data: {
            decision: decision.decision,
            planHash: plan.planHash,
            gatePolicyVersion: policy.gatePolicyVersion,
            findings: decision.findings.length,
          },
        });
      }

      const d = decision;
      const page = paginate({
        codec: ports.cursors,
        tool: 'validate_test_coverage',
        cursor: input.findingsCursor,
        limit: FINDINGS_PAGE,
        filter: null,
        snapshotId: d.id,
        items: d.findings,
        capChars: 12_000,
        render: (findings, meta) => ({ findings: [...findings], findingsNextCursor: meta.nextCursor }),
      });
      if (!page.ok) return fail(page.error);
      return ok({
        coverageDecisionId: d.id,
        decision: d.decision,
        planHash: d.planHash as `v1:sha256:${string}`,
        requirementSetHash: d.requirementSetHash as `sha256:${string}`,
        gatePolicyVersion: d.gatePolicyVersion as `sha256:${string}`,
        current: latest.planHash === d.planHash,
        findings: page.value.findings,
        findingsNextCursor: page.value.findingsNextCursor,
        metrics: d.metrics,
        requirementStatus: d.requirementStatus.slice(0, 200),
        nextSteps: nextSteps(d.decision, latest.planHash === d.planHash),
      });
    },
  };
}

function nextSteps(decision: CoverageDecision['decision'], current: boolean): string[] {
  const steps: string[] = [];
  if (!current) steps.push('A newer plan version exists; validate that version instead.');
  if (decision === 'fail')
    steps.push('Fix the blocker findings, then call generate_test_plan with basePlanId and validate again.');
  if (decision === 'needs_review')
    steps.push(
      'Revise the plan to clear the review findings, or request a human approval with request_approval (scope plan_execution).',
    );
  if (decision === 'pass')
    steps.push('Coverage criteria are met. run_tests evaluates execution authorization separately.');
  return steps;
}
