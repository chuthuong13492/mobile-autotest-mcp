/**
 * End to end across both apps (AUTH-004 + CLI-001 + AUTH-003): the MCP server opens an approval request for a
 * `needs_review` plan, a human approves it with `autotest approve` (simulated terminal), the server reports it
 * usable, and the real authorization evaluator authorizes exactly that plan, environment and target set.
 */
import { describe, expect, it } from 'vitest';
import { run, type Io } from '@autotest/cli';
import { authorizeExecution, defaultPlanTargets, nodeFsPort, resolveWorkspaces } from '@autotest/policy';
import { composeAt, HOST_ENV, sc, setupData, validatedPlan } from '../../apps/mcp-server/test/approvalSetup.ts';

const solver = (digest: string) => (prompt: string) =>
  /positions ([\d, ]+):/
    .exec(prompt)![1]!
    .split(',')
    .map((n) => digest.slice('sha256:'.length)[Number(n.trim()) - 1])
    .join('');

describe('approval flow: request (server) → approve (CLI) → authorize', () => {
  it('a CLI AL2 approval authorizes a needs_review plan; revocation takes effect at once', async () => {
    const { data } = setupData();
    const c = await composeAt(data);
    const plan = await validatedPlan(c, 'needs_review');
    const r = sc<{ approvalRequestId: string; scopeDigest: string }>(
      await c.call('request_approval', {
        scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
        justification: 'GR-02',
        offerElicitation: false,
      }),
    );

    const out: string[] = [];
    const io: Io = {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: (t) => out.push(t),
      err: (t) => out.push(t),
      ask: async (p) => solver(r.scopeDigest)(p),
    };
    expect(await run(['approve', r.approvalRequestId], io, { env: { ...HOST_ENV, AUTOTEST_HOME: data } })).toBe(0);
    expect(out.join('\n')).toMatch(/coverage:\s+needs_review with 1 finding/);
    expect(sc(await c.call('get_approval_status', { approvalRequestId: r.approvalRequestId }))).toMatchObject({
      request: { status: 'fulfilled' },
      approvals: [{ usable: true, assuranceLevel: 'AL2', source: 'cli' }],
    });

    if (!c.policy.ok) throw new Error('policy');
    const stored = (await c.ports.plans.getByHash(plan.planHash))!;
    const set = (await c.ports.requirements.get(stored.requirementSetId))!;
    const decision = (await c.ports.decisions.findCurrent({
      planHash: stored.planHash,
      requirementSetHash: set.requirementSetHash,
      gatePolicyVersion: c.policy.policy.gatePolicyVersion,
    }))!;
    const targets = defaultPlanTargets(stored);
    const authorize = async () =>
      authorizeExecution({
        decisionId: 'authz_01JC0000000000000000000000',
        phase: 'create',
        now: new Date(),
        request: {
          planId: stored.id,
          planHash: stored.planHash,
          targets,
          deviceIds: [],
          environment: 'local:test-host',
        },
        serverEnvironment: { id: 'local:test-host', kind: 'local' },
        policy: c.policy.ok ? c.policy.policy : undefined,
        plan: stored,
        latestPlanVersion: stored.version,
        currentRequirementSetHash: set.requirementSetHash,
        coverage: decision,
        approvals: await c.ports.approvals.listByScopeDigest(r.scopeDigest),
        workspace: c.policy.ok
          ? resolveWorkspaces(nodeFsPort(), c.policy.policy.config.workspaces).workspaces[0]
          : undefined,
        devices: [],
        commands: targets.map((t) => ({ targetId: t, ok: true })),
        prerequisites: { satisfied: true },
      });
    const before = await authorize();
    expect(before.decision.result).toBe('authorized');
    expect(await run(['revoke', before.approvalId!], io, { env: { ...HOST_ENV, AUTOTEST_HOME: data } })).toBe(0);
    expect((await authorize()).decision).toMatchObject({ result: 'denied', reasons: ['approval_revoked'] });
    await c.close();
  });
});
