import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { composeAt, sc, setupData, validatedPlan } from './approvalSetup.ts';

type Req = {
  approvalRequestId: string;
  scopeDigest: string;
  requiredAssurance: string;
  status: string;
  approvalId: string | null;
  instructions: { cliCommand: string };
  elicitationOutcome: string;
};

async function client(
  c: Awaited<ReturnType<typeof composeAt>>,
  answer?: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> },
) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await c.server.connect(st);
  const cl = new Client({ name: 't', version: '0' }, answer ? { capabilities: { elicitation: { form: {} } } } : {});
  if (answer) cl.setRequestHandler('elicitation/create', async () => answer);
  await cl.connect(ct);
  return cl;
}

describe('AUTH-004 request_approval', () => {
  it('opens one request per scope with CLI instructions; refuses failing or unvalidated plans', async () => {
    const { data } = setupData();
    const c = await composeAt(data);
    const plan = await validatedPlan(c, 'needs_review');
    const r = sc<Req>(
      await c.call('request_approval', {
        scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
        justification: 'GR-02 flagged a weak assertion',
        offerElicitation: false,
      }),
    );
    expect(r).toMatchObject({
      requiredAssurance: 'AL2',
      status: 'open',
      approvalId: null,
      elicitationOutcome: 'not_offered',
      instructions: { cliCommand: `autotest approve ${r.approvalRequestId}` },
    });
    const again = sc<Req>(
      await c.call('request_approval', {
        scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
        justification: 'again',
        offerElicitation: false,
      }),
    );
    expect(again.approvalRequestId).toBe(r.approvalRequestId);
    const stored = await c.ports.approvals.getRequest(r.approvalRequestId);
    expect(stored?.display?.justification).toBe('GR-02 flagged a weak assertion');
    expect(Object.keys(stored!.scope.params).sort()).toEqual(['environment', 'planHash', 'targetSetDigest']);
    expect(stored!.scope.params['environment']).toBe('local:test-host');
    expect((await c.ports.audit.readAll()).filter((e) => e.kind === 'approval.requested')).toHaveLength(1);

    const failing = await validatedPlan(c, 'fail');
    expect(
      sc(
        await c.call('request_approval', {
          scope: { kind: 'plan_execution', planId: failing.planId, planHash: failing.planHash },
          justification: 'x',
        }),
      ),
    ).toMatchObject({ error: { code: 'E_COVERAGE_FAILED' } });
    const unvalidated = await validatedPlan(c, 'unvalidated');
    expect(
      sc(
        await c.call('request_approval', {
          scope: { kind: 'plan_execution', planId: unvalidated.planId, planHash: unvalidated.planHash },
          justification: 'x',
        }),
      ),
    ).toMatchObject({ error: { code: 'E_COVERAGE_STALE' } });
    expect(
      sc(
        await c.call('request_approval', {
          scope: { kind: 'plan_execution', planId: plan.planId },
          justification: 'x',
        }),
      ),
    ).toMatchObject({ error: { code: 'E_VALIDATION' } });
    expect(
      sc(
        await c.call('request_approval', {
          scope: {
            kind: 'plan_execution',
            planId: plan.planId,
            planHash: plan.planHash,
            environment: 'local:elsewhere',
          },
          justification: 'x',
        }),
      ),
    ).toMatchObject({ error: { code: 'E_VALIDATION' } });
    expect(
      sc(
        await c.call('request_approval', {
          scope: {
            kind: 'plan_execution',
            planId: plan.planId,
            planHash: plan.planHash,
            targets: ['TT-example-000000000000'],
          },
          justification: 'x',
        }),
      ),
    ).toMatchObject({ error: { code: 'E_VALIDATION' } });
    expect(
      sc(
        await c.call('request_approval', {
          scope: {
            kind: 'github_publish',
            publish: { reportId: 'rpt_01JC0000000000000000000011', mechanisms: ['comment'] },
          },
          justification: 'x',
        }),
      ),
    ).toMatchObject({ error: { code: 'E_CAPABILITY_UNAVAILABLE' } });
    await c.close();
  });

  it('elicitation accept is AL1 at most: insufficient under the default policy (SEC-003)', async () => {
    const { data } = setupData();
    const c = await composeAt(data);
    const plan = await validatedPlan(c, 'needs_review');
    const cl = await client(c, { action: 'accept', content: { confirm: true } });
    const r = (
      await cl.callTool({
        name: 'request_approval',
        arguments: {
          scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
          justification: 'please',
        },
      })
    ).structuredContent as Req;
    expect(r).toMatchObject({
      status: 'open',
      approvalId: null,
      elicitationOutcome: 'accepted_insufficient',
      requiredAssurance: 'AL2',
    });
    expect(await c.ports.approvals.listRecentApprovals(10)).toEqual([]);
    await cl.close();
    await c.close();
  });

  it('where policy explicitly allows AL1, an accept creates an AL1 elicitation approval', async () => {
    const { data } = setupData(
      'approvals: { allowWeakApprovals: true, minAssurance: { plan_execution: { local: AL1 } } }\n',
    );
    const c = await composeAt(data);
    const plan = await validatedPlan(c, 'needs_review');
    const cl = await client(c, { action: 'accept', content: { confirm: true } });
    const r = (
      await cl.callTool({
        name: 'request_approval',
        arguments: {
          scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
          justification: 'ok',
        },
      })
    ).structuredContent as Req;
    expect(r).toMatchObject({ status: 'fulfilled', elicitationOutcome: 'accepted', requiredAssurance: 'AL1' });
    const a = await c.ports.approvals.getApproval(r.approvalId!);
    expect(a).toMatchObject({
      source: 'elicitation',
      assuranceLevel: 'AL1',
      planHash: plan.planHash,
      environment: 'local:test-host',
      maxUses: 3,
    });
    const status = sc<{ approvals: { usable: boolean }[]; request: { status: string } }>(
      await c.call('get_approval_status', { approvalId: r.approvalId }),
    );
    expect(status).toMatchObject({ request: { status: 'fulfilled' }, approvals: [{ usable: true }] });
    await cl.close();
    await c.close();
  });

  it('decline and missing capability are reported; the request stays open', async () => {
    const { data } = setupData();
    const c = await composeAt(data);
    const plan = await validatedPlan(c, 'needs_review');
    const args = {
      scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
      justification: 'x',
    };
    const declining = await client(c, { action: 'decline' });
    expect(
      ((await declining.callTool({ name: 'request_approval', arguments: args })).structuredContent as Req)
        .elicitationOutcome,
    ).toBe('declined');
    await declining.close();
    const plain = await client(c);
    expect(
      (await plain.callTool({ name: 'request_approval', arguments: args })).structuredContent as Req,
    ).toMatchObject({ elicitationOutcome: 'not_offered', status: 'open' });
    await plain.close();
    await c.close();
  });
});

describe('AUTH-004 get_approval_status', () => {
  it('reports the request and maps lookups', async () => {
    const { data } = setupData();
    const c = await composeAt(data);
    const plan = await validatedPlan(c, 'needs_review');
    const r = sc<Req>(
      await c.call('request_approval', {
        scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
        justification: 'x',
        offerElicitation: false,
      }),
    );
    expect(sc(await c.call('get_approval_status', { approvalRequestId: r.approvalRequestId }))).toMatchObject({
      request: { id: r.approvalRequestId, status: 'open', requiredAssurance: 'AL2' },
      approvals: [],
    });
    expect(
      sc(await c.call('get_approval_status', { approvalRequestId: 'apr_01JC0000000000000000000000' })),
    ).toMatchObject({ error: { code: 'E_NOT_FOUND' } });
    expect(sc(await c.call('get_approval_status', { approvalId: 'appr_01JC0000000000000000000000' }))).toMatchObject({
      error: { code: 'E_NOT_FOUND' },
    });
    expect(sc(await c.call('get_approval_status', {}))).toMatchObject({ error: { code: 'E_VALIDATION' } });
    await c.close();
  });
});
