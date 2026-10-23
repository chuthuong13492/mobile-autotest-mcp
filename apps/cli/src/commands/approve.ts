/**
 * `autotest approve <approvalRequestId>` (CLI-001; ADR-0006 AL2; T-15).
 *
 * The command refuses unless both stdin and stdout are terminals. It shows what is being approved — summary, scope
 * kind and digest, plan hash, environment, the coverage decision and its review findings for plan execution, and
 * the agent's justification labelled as untrusted — then asks the human to type the digest characters at six
 * random positions. Only a correct answer creates an AL2 approval bound to the scope digest, plan hash, this
 * host's environment id and the current policy version.
 *
 * This resists approval by an agent that drives a non-interactive shell; it does not prove that a human acted.
 * An agent with an unrestricted interactive shell as the same OS user could still answer (RK-01): use the
 * recommended Claude Code deny rules, a sandbox, or AL3.
 */
import { randomInt } from 'node:crypto';
import { grantApproval } from '@autotest/workflow';
import type { CliContext, CliEnv } from '../context.ts';
import type { Io } from '../io.ts';

const POSITIONS = 6;

/** Six distinct 1-based positions in a 64-character hex digest, ascending. */
export function challengePositions(rand: (max: number) => number = randomInt): number[] {
  const set = new Set<number>();
  while (set.size < POSITIONS) set.add(rand(64) + 1);
  return [...set].sort((a, b) => a - b);
}

export async function approve(requestId: string, ctx: CliContext, io: Io, e: CliEnv): Promise<number> {
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
  const digestHex = request.scope.digest.slice('sha256:'.length);
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

  const positions = challengePositions(e.randomInt);
  const expected = positions.map((i) => digestHex[i - 1]).join('');
  const answer = (await io.ask(`Type the scope-digest characters at positions ${positions.join(', ')}: `))
    .replace(/\s+/g, '')
    .toLowerCase();
  if (answer !== expected) {
    io.err('Challenge failed. Nothing was approved.');
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
