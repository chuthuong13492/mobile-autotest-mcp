/**
 * `autotest approve <approvalRequestId>` (CLI-001; ADR-0006 AL2; T-15).
 *
 * The command refuses unless both stdin and stdout are terminals. It shows what is being approved — summary, scope
 * kind and digest, plan hash, environment, the coverage decision and its review findings for plan execution, and
 * the agent's justification labelled as untrusted — then asks `Approve this? [y/N]`. Only `y` or `yes` (any case)
 * creates an AL2 approval bound to the scope digest, plan hash, this host's environment id and the current policy
 * version; Enter, any other answer, end of input or a read error refuses (the default is No).
 *
 * This resists approval by an agent that drives a non-interactive shell; it does not prove that a human acted.
 * An agent with an unrestricted interactive shell as the same OS user could still answer (RK-01; the digest
 * challenge this replaced in 1.3.0 did not stop that either): use the recommended Claude Code deny rules, a sandbox,
 * or AL3. There is deliberately no `--yes` flag.
 */
import { grantApproval } from '@autotest/workflow';
import type { CliContext } from '../context.ts';
import type { Io } from '../io.ts';

/** True only for an explicit yes: `y` or `yes`, any case, surrounding spaces ignored. */
export const isExplicitYes = (answer: string) => /^(?:y|yes)$/i.test(answer.trim());

export async function approve(requestId: string, ctx: CliContext, io: Io): Promise<number> {
  if (!io.stdinIsTTY || !io.stdoutIsTTY) {
    io.err(
      'autotest approve must run interactively in a terminal (stdin and stdout must be a TTY). Nothing was approved.',
    );
    return 1;
  }
  if (!ctx.policy.ok) {
    io.err('The user policy (config.yaml) is missing or invalid; approvals are bound to it. Run `autotest doctor`.');
    return 1;
  }
  const now = ctx.ports.clock.now();
  await ctx.ports.approvals.expireDue(now);
  const request = await ctx.ports.approvals.getRequest(requestId);
  if (!request) {
    io.err(`No approval request ${requestId}.`);
    return 1;
  }
  if (request.status !== 'open') {
    io.err(`Request ${requestId} is ${request.status}; nothing to approve.`);
    return 1;
  }
  if (request.requiredAssurance === 'AL3') {
    io.err(`Request ${requestId} requires AL3; CLI approvals are AL2. Use the organization's AL3 path.`);
    return 1;
  }

  const p = request.scope.params;
  io.out('AutoTest approval request');
  io.out(`  request:      ${request.id} (expires ${request.expiresAt})`);
  io.out(`  what:         ${request.display?.summary ?? request.scope.kind}`);
  io.out(`  scope:        ${request.scope.kind}`);
  io.out(`  scope digest: ${request.scope.digest}`);
  if (typeof p['planHash'] === 'string') io.out(`  plan hash:    ${p['planHash']}`);
  io.out(`  environment:  ${ctx.environment.id}`);
  io.out(`  assurance:    ${request.requiredAssurance} required; this approval will be AL2`);
  if (request.scope.kind === 'plan_execution' && typeof p['planHash'] === 'string') {
    const plan = await ctx.ports.plans.getByHash(p['planHash']);
    const set = plan && (await ctx.ports.requirements.get(plan.requirementSetId));
    const decision =
      set &&
      (await ctx.ports.decisions.findCurrent({
        planHash: plan.planHash,
        requirementSetHash: set.requirementSetHash,
        gatePolicyVersion: ctx.policy.policy.gatePolicyVersion,
      }));
    if (!decision) io.out('  coverage:     no current decision (authorization will deny until the plan is validated)');
    else {
      const review = decision.findings.filter((f) => f.severity !== 'info');
      io.out(`  coverage:     ${decision.decision} with ${review.length} finding(s)`);
      for (const f of review.slice(0, 10)) io.out(`    - ${f.ruleId}: ${f.message}`);
      if (review.length > 10) io.out(`    … ${review.length - 10} more`);
    }
  }
  io.out(`  agent-provided justification (untrusted): ${request.display?.justification || '—'}`);

  // A read error or end of input is a No.
  const answer = await io.ask('Approve this? [y/N] ').catch(() => '');
  if (!isExplicitYes(answer)) {
    io.err('Not approved. Nothing was approved.');
    return 1;
  }
  const granted = await grantApproval(ctx.ports, {
    request,
    source: 'cli',
    assurance: 'AL2',
    approver: { osUser: ctx.osUser },
    environment: ctx.environment.id,
    policyVersion: ctx.policy.policy.policyVersion,
    actor: 'cli',
  });
  if (!granted.ok) {
    io.err(granted.error.error.message);
    return 1;
  }
  io.out(
    `Approved: ${granted.approval.id} (AL2, ${granted.approval.maxUses} use(s), expires ${granted.approval.expiresAt}).`,
  );
  return 0;
}
