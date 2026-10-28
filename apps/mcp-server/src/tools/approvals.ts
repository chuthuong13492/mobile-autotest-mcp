/**
 * TL-07 `request_approval` and TL-08 `get_approval_status` (AUTH-004; FR-021, SR-007; ADR-0006; T-15).
 *
 * `request_approval` computes the scope exactly as authorization will (plan hash + environment + resolved target
 * set; or the exception, device or publication parameters), refuses plans whose current coverage decision is
 * `fail`, and persists an `ApprovalRequest` with CLI instructions. It never grants above AL1: the optional
 * elicitation step in the MCP server (see `elicitation.ts`) can create an AL1 approval only where policy allows AL1;
 * AL2 comes from `autotest approve` (CLI-001). An identical open scope returns the existing request.
 * `get_approval_status` reports each approval's usability against the current bindings, after lazy expiry.
 */
import { PortError, toolError, type ApprovalRequest, type ApprovalScope, type TestPlan } from '@autotest/core';
import {
  coverageExceptionScope,
  defaultPlanTargets,
  deviceActionScope,
  minAssurance,
  planExecutionScope,
  resolvePlanTargets,
  verifyApproval,
  NO_AL3,
  type PolicyEnvironment,
  type PolicyLoadResult,
} from '@autotest/policy';
import { fail, ok, publicationTarget, type UseCases, type WorkflowPorts } from '@autotest/workflow';

export interface ApprovalDeps {
  readonly ports: WorkflowPorts;
  readonly policy: PolicyLoadResult;
  readonly serverEnvironment: { readonly id: string; readonly kind: PolicyEnvironment };
  readonly requestTtlMs?: number;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const invalid = (pointer: string, message: string) =>
  fail(toolError('E_VALIDATION', message, [], { issues: [{ pointer, message }] }));

export function approvalUseCases(deps: ApprovalDeps): Pick<UseCases, 'request_approval' | 'get_approval_status'> {
  const { ports } = deps;
  return {
    async request_approval(input) {
      if (!deps.policy.ok)
        return fail(
          toolError('E_POLICY_UNAVAILABLE', 'the user policy is missing or invalid', [
            'Fix ~/.autotest/config.yaml, then run `autotest doctor`.',
          ]),
        );
      const policy = deps.policy.policy;
      const s = input.scope;
      const environment = s.environment ?? deps.serverEnvironment.id;
      if (environment !== deps.serverEnvironment.id)
        return invalid('/scope/environment', `this server can only bind approvals to ${deps.serverEnvironment.id}`);

      let scope: ApprovalScope;
      let summary: string;
      if (s.kind === 'plan_execution' || s.kind === 'coverage_exception') {
        if (!s.planId || !s.planHash) return invalid('/scope/planHash', `${s.kind} requires planId and planHash`);
        const plan = await planVersion(ports, s.planId, s.planHash);
        if (!plan)
          return fail(
            toolError('E_NOT_FOUND', 'no version of this plan has that planHash', [
              'Use the planHash returned by generate_test_plan',
            ]),
          );
        if (s.kind === 'plan_execution') {
          const set = await ports.requirements.get(plan.requirementSetId);
          const decision =
            set &&
            (await ports.decisions.findCurrent({
              planHash: plan.planHash,
              requirementSetHash: set.requirementSetHash,
              gatePolicyVersion: policy.gatePolicyVersion,
            }));
          if (!decision)
            return fail(
              toolError('E_COVERAGE_STALE', 'no current coverage decision for this plan', [
                'Call validate_test_coverage first',
              ]),
            );
          if (decision.decision === 'fail')
            return fail(
              toolError('E_COVERAGE_FAILED', 'a plan whose coverage decision is fail cannot be approved', [
                'Fix the blocker findings and generate a new plan version',
              ]),
            );
          const targets = s.targets ? resolvePlanTargets(plan, s.targets) : defaultPlanTargets(plan);
          if (!targets || targets.length === 0)
            return invalid('/scope/targets', 'targets must be eligible plan targets');
          scope = planExecutionScope({ planHash: plan.planHash, environment, targetIds: targets });
          summary = `run plan ${plan.id} v${plan.version} (${targets.length} targets, coverage ${decision.decision}) in ${environment}`;
        } else {
          if (!s.exceptionIds || s.exceptionIds.length !== 1)
            return invalid('/scope/exceptionIds', 'name exactly one exception per request');
          const exception = plan.exceptions.find((e) => e.id === s.exceptionIds![0]);
          if (!exception)
            return fail(toolError('E_NOT_FOUND', `exception ${s.exceptionIds[0]} is not in this plan`, []));
          scope = coverageExceptionScope({ planHash: plan.planHash, exception });
          summary = `accept exception ${exception.id} (${exception.reason}) for ${exception.requirementRefs.join(', ')} in plan ${plan.id} v${plan.version}`;
        }
      } else if (s.kind === 'device_action') {
        if (!s.deviceAction) return invalid('/scope/deviceAction', 'device_action requires deviceAction');
        scope = deviceActionScope({
          action: s.deviceAction.action,
          deviceId: s.deviceAction.deviceId,
          hostId: environment,
        });
        summary =
          s.deviceAction.action === 'use_non_owned'
            ? `let AutoTest use your device ${s.deviceAction.deviceId} for test runs: it boots it if needed, installs and runs the app under test; it never erases, deletes or shuts it down`
            : `${s.deviceAction.action} on device ${s.deviceAction.deviceId}`;
      } else {
        if (!s.publish) return invalid('/scope/publish', 'github_publish requires publish {reportId, mechanisms}');
        const target = await publicationTarget(ports, s.publish.reportId, s.publish.mechanisms);
        if (!target.ok) return fail(target.error);
        scope = target.target.scope;
        const { pr, mechanisms, report } = target.target;
        summary = `publish report ${report.id} (${report.verdict}) to ${pr.owner}/${pr.name}#${pr.number} at ${pr.headSha.slice(0, 7)} as ${mechanisms.join(' + ')}`;
      }

      const { required } = minAssurance(scope.kind, deps.serverEnvironment.kind, policy.config.approvals.minAssurance);
      if (required === 'not_allowed')
        return fail(toolError('E_POLICY_DENIED', `${scope.kind} is not allowed in ${deps.serverEnvironment.kind}`, []));
      const requiredAssurance = required === 'none' ? 'AL1' : required;
      const now = ports.clock.now();
      let request = await ports.approvals.findOpenRequest(scope.digest, now);
      if (!request) {
        const id = ports.ids.newId('apr');
        const expiresAt = iso(new Date(now.getTime() + (deps.requestTtlMs ?? 24 * 3_600_000)));
        request = {
          id,
          schemaVersion: 1,
          createdAt: iso(now),
          expiresAt,
          scope,
          requiredAssurance,
          status: 'open',
          instructions: { cliCommand: `autotest approve ${id}`, expiresAt },
          createdBy: 'agent',
          display: { summary: summary.slice(0, 300), justification: input.justification.slice(0, 2000) },
        } satisfies ApprovalRequest;
        await ports.approvals.putRequest(request);
        await ports.audit.append({
          ts: iso(now),
          actor: 'agent',
          kind: 'approval.requested',
          subjectRefs: [id],
          data: { scopeKind: scope.kind, scopeDigest: scope.digest, requiredAssurance },
        });
      }
      return ok({
        approvalRequestId: request.id,
        scopeDigest: request.scope.digest as `sha256:${string}`,
        requiredAssurance: request.requiredAssurance,
        status: request.status,
        approvalId: null,
        instructions: request.instructions,
        elicitationOutcome: 'not_offered',
      });
    },

    async get_approval_status(input) {
      if (!deps.policy.ok) return fail(toolError('E_POLICY_UNAVAILABLE', 'the user policy is missing or invalid', []));
      const policy = deps.policy.policy;
      const now = ports.clock.now();
      try {
        await ports.approvals.expireDue(now);
        let request: ApprovalRequest | undefined;
        if (input.approvalRequestId) {
          request = await ports.approvals.getRequest(input.approvalRequestId);
          if (!request) return fail(toolError('E_NOT_FOUND', 'approval request not found', []));
        }
        const approvals = input.approvalId
          ? [await ports.approvals.getApproval(input.approvalId)].filter((a) => a !== undefined)
          : await ports.approvals.listByScopeDigest(request!.scope.digest);
        if (input.approvalId && approvals.length === 0) return fail(toolError('E_NOT_FOUND', 'approval not found', []));
        if (!request && approvals[0]?.requestId) request = await ports.approvals.getRequest(approvals[0].requestId);
        return ok({
          request: request
            ? {
                id: request.id,
                status: request.status,
                scopeDigest: request.scope.digest as `sha256:${string}`,
                requiredAssurance: request.requiredAssurance,
                expiresAt: request.expiresAt,
              }
            : null,
          approvals: approvals
            .slice(-20)
            .reverse()
            .map((a) => {
              const v = verifyApproval(
                a,
                {
                  scope: a.scope,
                  ...(a.planHash ? { planHash: a.planHash } : {}),
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
              return {
                approvalId: a.id,
                state: a.state,
                assuranceLevel: a.assuranceLevel,
                source: a.source,
                usable: v.usable,
                unusableReasons: [...v.reasons],
                expiresAt: a.expiresAt,
                uses: a.uses,
                maxUses: a.maxUses,
              };
            }),
        });
      } catch (e) {
        if (e instanceof PortError && e.code === 'integrity')
          return fail(
            toolError('E_STORAGE_CORRUPT', 'an approval record failed its integrity check and is unusable', [
              'Run `autotest doctor`',
            ]),
          );
        throw e;
      }
    },
  };
}

async function planVersion(ports: WorkflowPorts, planId: string, planHash: string): Promise<TestPlan | undefined> {
  const p = await ports.plans.getByHash(planHash);
  return p && p.id === planId ? p : undefined;
}
