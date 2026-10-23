/**
 * Shared port contract cases (CORE-004). Framework-agnostic: each case throws on failure (node:assert), so the
 * in-memory fakes and the SQLite repositories (STO-003) run the identical semantics checks.
 */
import assert from 'node:assert/strict';
import { computePlanHash, type ExecutionAuthorizationDecision } from '@autotest/contracts';
import { verifyAuditChain } from '../audit.ts';
import {
  PortError,
  type ApprovalStore,
  type AuditSink,
  type DecisionStore,
  type PlanStore,
  type ResultStore,
  type RunStore,
  type AuthorizationStore,
  type IdempotencyRecord,
  type IdempotencyStore,
  type InventoryStore,
  type PrContextStore,
  type ProfileStore,
} from '../ports.ts';
import {
  samplePrContext,
  sampleInventory,
  sampleProfile,
  sampleApproval,
  sampleApprovalRequest,
  sampleDecision,
  samplePlan,
  sampleResult,
  sampleRun,
  sha,
} from './samples.ts';

export interface ContractCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

const rejectsWith = async (p: Promise<unknown>, code: PortError['code']) =>
  assert.rejects(p, (e: unknown) => e instanceof PortError && e.code === code);

export function planStoreCases(make: () => PlanStore): ContractCase[] {
  return [
    {
      name: 'plan store: round-trips and returns the latest version by default',
      run: async () => {
        const s = make();
        const v1 = samplePlan();
        const v2 = samplePlan({ version: 2, testCases: [{ ...v1.testCases[0]!, title: 'Badge shows count (v2)' }] });
        await s.put(v1);
        await s.put(v2);
        assert.equal((await s.get(v1.id))?.version, 2);
        assert.equal((await s.get(v1.id, 1))?.planHash, v1.planHash);
        assert.equal((await s.getByHash(v2.planHash))?.version, 2);
      },
    },
    {
      name: 'plan store: versions are immutable (identical re-put ok, different content conflicts)',
      run: async () => {
        const s = make();
        const p = samplePlan();
        await s.put(p);
        await s.put(structuredClone(p));
        const changed = { ...p, testCases: [{ ...p.testCases[0]!, title: 'tampered' }] };
        await rejectsWith(s.put({ ...changed, planHash: computePlanHash(changed) }), 'conflict');
      },
    },
    {
      name: 'plan store: stored values cannot be mutated through returned objects',
      run: async () => {
        const s = make();
        const p = samplePlan();
        await s.put(p);
        const got = (await s.get(p.id))!;
        got.testCases[0]!.title = 'mutated';
        assert.equal((await s.get(p.id))?.testCases[0]?.title, p.testCases[0]!.title);
      },
    },
  ];
}

export function decisionStoreCases(make: () => DecisionStore): ContractCase[] {
  return [
    {
      name: 'decision store: findCurrent requires all three bindings (ADR-0005)',
      run: async () => {
        const s = make();
        const d = sampleDecision();
        await s.put(d);
        const b = {
          planHash: d.planHash,
          requirementSetHash: d.requirementSetHash,
          gatePolicyVersion: d.gatePolicyVersion,
        };
        assert.equal((await s.findCurrent(b))?.id, d.id);
        assert.equal(await s.findCurrent({ ...b, planHash: `v1:sha256:${'9'.repeat(64)}` }), undefined);
        assert.equal(await s.findCurrent({ ...b, requirementSetHash: sha('9') }), undefined);
        assert.equal(await s.findCurrent({ ...b, gatePolicyVersion: sha('9') }), undefined);
      },
    },
  ];
}

export function approvalStoreCases(make: () => ApprovalStore): ContractCase[] {
  const at = new Date('2026-10-23T01:00:00Z');
  return [
    {
      name: 'approval store: consume counts uses and moves to consumed at maxUses',
      run: async () => {
        const s = make();
        const a = sampleApproval({ maxUses: 2 });
        await s.putApproval(a);
        assert.equal((await s.consume(a.id, at)).uses, 1);
        const second = await s.consume(a.id, at);
        assert.equal(second.uses, 2);
        assert.equal(second.state, 'consumed');
        await rejectsWith(s.consume(a.id, at), 'not_usable');
      },
    },
    {
      name: 'approval store: concurrent consumes never exceed maxUses',
      run: async () => {
        const s = make();
        const a = sampleApproval({ maxUses: 3 });
        await s.putApproval(a);
        const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => s.consume(a.id, at)));
        assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 3);
        assert.equal((await s.getApproval(a.id))?.uses, 3);
      },
    },
    {
      name: 'approval store: expired, revoked and superseded approvals cannot be consumed',
      run: async () => {
        const s = make();
        const expired = sampleApproval({ id: 'appr_01JC1111111111111111111111', expiresAt: '2026-10-23T00:30:00Z' });
        const revoked = sampleApproval({ id: 'appr_01JC2222222222222222222222' });
        const superseded = sampleApproval({
          id: 'appr_01JC3333333333333333333333',
          planHash: `v1:sha256:${'7'.repeat(64)}`,
        });
        for (const a of [expired, revoked, superseded]) await s.putApproval(a);
        await rejectsWith(s.consume(expired.id, at), 'not_usable');
        await s.revoke(revoked.id, 'dev', at);
        await rejectsWith(s.consume(revoked.id, at), 'not_usable');
        assert.equal(await s.supersedeByPlanHash(superseded.planHash!), 1);
        await rejectsWith(s.consume(superseded.id, at), 'not_usable');
      },
    },
    {
      name: 'approval store: lazy expiry persists expired on consume',
      run: async () => {
        const s = make();
        const a = sampleApproval({ expiresAt: '2026-10-23T00:30:00Z' });
        await s.putApproval(a);
        await rejectsWith(s.consume(a.id, at), 'not_usable');
        assert.equal((await s.getApproval(a.id))?.state, 'expired');
      },
    },
    {
      name: 'approval store: expireDue sweeps approvals and open requests',
      run: async () => {
        const s = make();
        const due = sampleApproval({ id: 'appr_01JC1111111111111111111111', expiresAt: '2026-10-23T00:30:00Z' });
        const live = sampleApproval({ id: 'appr_01JC2222222222222222222222' });
        await s.putApproval(due);
        await s.putApproval(live);
        await s.putRequest(sampleApprovalRequest({ expiresAt: '2026-10-23T00:30:00Z' }));
        assert.deepEqual(await s.expireDue(at), { approvals: 1, requests: 1 });
        assert.equal((await s.getApproval(due.id))?.state, 'expired');
        assert.equal((await s.getApproval(live.id))?.state, 'approved');
        assert.equal((await s.getRequest(sampleApprovalRequest().id))?.status, 'expired');
        assert.deepEqual(await s.expireDue(at), { approvals: 0, requests: 0 });
      },
    },
    {
      name: 'approval store: only approved or pending approvals can be revoked',
      run: async () => {
        const s = make();
        const a = sampleApproval({ maxUses: 1 });
        await s.putApproval(a);
        await s.consume(a.id, at);
        await rejectsWith(s.revoke(a.id, 'dev', at), 'not_usable');
        await rejectsWith(s.revoke('appr_01JC0000000000000000000000', 'dev', at), 'not_found');
      },
    },
    {
      name: 'approval store: requests round-trip and status updates replace them',
      run: async () => {
        const s = make();
        const r = sampleApprovalRequest();
        await s.putRequest(r);
        assert.deepEqual(await s.getRequest(r.id), r);
        await s.putRequest({ ...r, status: 'fulfilled' });
        assert.equal((await s.getRequest(r.id))?.status, 'fulfilled');
        assert.equal(await s.getRequest('apr_01JC0000000000000000000000'), undefined);
      },
    },
    {
      name: 'approval store: finds open requests by digest and lists open requests and recent approvals',
      run: async () => {
        const s = make();
        const r = sampleApprovalRequest();
        await s.putRequest(r);
        assert.equal((await s.findOpenRequest(r.scope.digest, at))?.id, r.id);
        assert.equal(await s.findOpenRequest(sha('0'), at), undefined);
        assert.equal(await s.findOpenRequest(r.scope.digest, new Date('2026-10-23T05:00:00Z')), undefined);
        await s.putRequest({ ...r, status: 'fulfilled' });
        assert.equal(await s.findOpenRequest(r.scope.digest, at), undefined);
        await s.putRequest({ ...r, id: 'apr_01JC9999999999999999999999' });
        assert.deepEqual(
          (await s.listOpenRequests(at, 10)).map((x) => x.id),
          ['apr_01JC9999999999999999999999'],
        );
        await s.putApproval(sampleApproval());
        await s.putApproval(sampleApproval({ id: 'appr_01JC2222222222222222222222' }));
        assert.deepEqual((await s.listRecentApprovals(1)).length, 1);
        assert.deepEqual((await s.listRecentApprovals(10)).length, 2);
      },
    },
    {
      name: 'approval store: lists approvals by scope digest',
      run: async () => {
        const s = make();
        const a = sampleApproval();
        await s.putApproval(a);
        assert.deepEqual(
          (await s.listByScopeDigest(a.scope.digest)).map((x) => x.id),
          [a.id],
        );
        assert.deepEqual(await s.listByScopeDigest(sha('0')), []);
      },
    },
  ];
}

export function authorizationStoreCases(make: () => AuthorizationStore): ContractCase[] {
  const decision = (
    id: string,
    runId: string | undefined,
    phase: 'create' | 'dispatch',
    at: string,
  ): ExecutionAuthorizationDecision => ({
    id,
    schemaVersion: 1,
    ...(runId ? { runId } : {}),
    phase,
    result: phase === 'create' ? 'authorized' : 'denied',
    reasons: phase === 'create' ? [] : ['approval_revoked' as const],
    inputsDigest: `sha256:${'b'.repeat(64)}`,
    evaluatedAt: at,
  });
  return [
    {
      name: 'authorization store: round-trips, lists by run in order, identical re-put ok, different content conflicts',
      run: async () => {
        const s = make();
        const run = 'run_01JC000000000000000000000A';
        await s.put(decision('authz_01JC0000000000000000000001', run, 'create', '2026-10-23T10:00:00Z'));
        await s.put(decision('authz_01JC0000000000000000000002', run, 'dispatch', '2026-10-23T10:00:05Z'));
        await s.put(decision('authz_01JC0000000000000000000003', undefined, 'create', '2026-10-23T10:00:01Z'));
        await s.put(decision('authz_01JC0000000000000000000001', run, 'create', '2026-10-23T10:00:00Z'));
        assert.deepEqual(
          (await s.listByRun(run)).map((d) => [d.id, d.phase, d.result, d.reasons]),
          [
            ['authz_01JC0000000000000000000001', 'create', 'authorized', []],
            ['authz_01JC0000000000000000000002', 'dispatch', 'denied', ['approval_revoked']],
          ],
        );
        assert.equal((await s.get('authz_01JC0000000000000000000003'))?.runId, undefined);
        await assert.rejects(
          s.put(decision('authz_01JC0000000000000000000001', run, 'create', '2026-10-23T11:00:00Z')),
          (e: unknown) => e instanceof PortError && e.code === 'conflict',
        );
      },
    },
  ];
}

export function runStoreCases(make: () => RunStore): ContractCase[] {
  return [
    {
      name: 'run store: idempotency keys are unique',
      run: async () => {
        const s = make();
        await s.create(sampleRun({ idempotencyKey: 'k1' }));
        await rejectsWith(
          s.create(sampleRun({ id: 'run_01JC4444444444444444444444', idempotencyKey: 'k1' })),
          'conflict',
        );
        assert.equal((await s.findByIdempotencyKey('k1'))?.idempotencyKey, 'k1');
      },
    },
    {
      name: 'run store: optimistic update rejects a stale expected state',
      run: async () => {
        const s = make();
        const r = sampleRun();
        await s.create(r);
        await s.update(r.id, { state: 'preparing', statusCategory: 'pending' }, 'queued');
        await rejectsWith(s.update(r.id, { state: 'running', statusCategory: 'running' }, 'queued'), 'stale');
        assert.equal((await s.get(r.id))?.state, 'preparing');
      },
    },
    {
      name: 'run store: listNonTerminal excludes terminal runs',
      run: async () => {
        const s = make();
        await s.create(sampleRun());
        await s.create(
          sampleRun({ id: 'run_01JC5555555555555555555555', state: 'completed', statusCategory: 'completed' }),
        );
        assert.deepEqual(
          (await s.listNonTerminal()).map((r) => r.state),
          ['queued'],
        );
      },
    },
  ];
}

export function resultStoreCases(make: () => ResultStore): ContractCase[] {
  return [
    {
      name: 'result store: paging returns every result exactly once in stable order (FR-024)',
      run: async () => {
        const s = make();
        const all = Array.from({ length: 2000 }, (_, i) => sampleResult(i + 1));
        await s.append(all);
        const seen: string[] = [];
        for (let offset = 0; ; offset += 137) {
          const page = await s.list(all[0]!.runId, { offset, limit: 137 });
          assert.equal(page.total, 2000);
          if (page.items.length === 0) break;
          seen.push(...page.items.map((r) => r.id));
        }
        assert.deepEqual(
          seen,
          all.map((r) => r.id),
        );
        const failed = await s.list(all[0]!.runId, { offset: 0, limit: 5000, outcomes: ['failed'] });
        assert.equal(failed.total, all.filter((r) => r.outcome === 'failed').length);
      },
    },
  ];
}

export function auditSinkCases(make: () => AuditSink): ContractCase[] {
  return [
    {
      name: 'audit sink: assigns seq and a verifiable hash chain (SR-015)',
      run: async () => {
        const s = make();
        for (let i = 0; i < 5; i++) {
          await s.append({
            ts: '2026-10-23T00:00:00Z',
            actor: 'server',
            kind: 'tool.call',
            subjectRefs: [`x${i}`],
            data: { tool: 'get_pr_context', toolCallId: `call-${i}` },
          });
        }
        const events = await s.readAll();
        assert.deepEqual(
          events.map((e) => e.seq),
          [0, 1, 2, 3, 4],
        );
        assert.equal(events[0]!.prevHash, null);
        assert.equal(verifyAuditChain(events), -1);
      },
    },
    {
      name: 'audit sink: rejects raw content and missing required data (fail closed)',
      run: async () => {
        const s = make();
        const base = { ts: '2026-10-23T00:00:00Z', actor: 'server' as const, subjectRefs: [] };
        await assert.rejects(s.append({ ...base, kind: 'tool.call', data: { tool: 'x' } }), /missing toolCallId/);
        await assert.rejects(
          s.append({ ...base, kind: 'tool.call', data: { tool: 'x', toolCallId: 'c', prBody: 'line1\nline2' } }),
          /multi-line/,
        );
        await assert.rejects(
          s.append({ ...base, kind: 'reconciliation.action', data: { action: 'x'.repeat(300) } }),
          /too long/,
        );
        assert.deepEqual(await s.readAll(), []);
      },
    },
  ];
}

export function idempotencyStoreCases(make: () => IdempotencyStore): ContractCase[] {
  const at = new Date('2026-10-23T01:00:00Z');
  const rec = (over: Partial<IdempotencyRecord> = {}): IdempotencyRecord => ({
    tool: 'run_tests',
    key: 'k-1',
    requestDigest: sha('1'),
    result: { runId: 'run_x', state: 'queued' },
    expiresAt: '2026-10-24T01:00:00Z',
    ...over,
  });
  return [
    {
      name: 'idempotency store: first write wins and is returned to later writers',
      run: async () => {
        const s = make();
        assert.deepEqual(await s.putIfAbsent(rec(), at), rec());
        assert.deepEqual(await s.putIfAbsent(rec({ requestDigest: sha('2'), result: { other: true } }), at), rec());
        assert.deepEqual(await s.get('run_tests', 'k-1', at), rec());
      },
    },
    {
      name: 'idempotency store: keys are scoped per tool and expire',
      run: async () => {
        const s = make();
        await s.putIfAbsent(rec(), at);
        assert.equal(await s.get('request_approval', 'k-1', at), undefined);
        assert.equal(await s.get('run_tests', 'k-1', new Date('2026-10-24T01:00:00Z')), undefined);
        const replaced = await s.putIfAbsent(
          rec({ requestDigest: sha('3'), expiresAt: '2026-10-26T00:00:00Z' }),
          new Date('2026-10-25T00:00:00Z'),
        );
        assert.equal(replaced.requestDigest, sha('3'));
      },
    },
  ];
}

export function profileStoreCases(make: () => ProfileStore): ContractCase[] {
  return [
    {
      name: 'profile store: round-trips and is immutable',
      run: async () => {
        const s = make();
        const p = sampleProfile();
        await s.put(p);
        await s.put(structuredClone(p));
        assert.deepEqual(await s.get(p.id), p);
        await rejectsWith(s.put({ ...p, languages: ['kotlin'] }), 'conflict');
        assert.equal(await s.get('prj_01JC0000000000000000000000'), undefined);
      },
    },
  ];
}

export function inventoryStoreCases(make: () => InventoryStore): ContractCase[] {
  return [
    {
      name: 'inventory store: round-trips and is immutable',
      run: async () => {
        const s = make();
        const inv = sampleInventory();
        await s.put(inv);
        await s.put(structuredClone(inv));
        assert.deepEqual(await s.get(inv.id), inv);
        await rejectsWith(s.put({ ...inv, targets: [] }), 'conflict');
        const got = (await s.get(inv.id))!;
        got.targets.length = 0;
        assert.equal((await s.get(inv.id))?.targets.length, 1);
      },
    },
  ];
}

export function prContextStoreCases(make: () => PrContextStore): ContractCase[] {
  return [
    {
      name: 'pr context store: round-trips and is immutable',
      run: async () => {
        const s = make();
        const c = samplePrContext();
        await s.put(c);
        assert.deepEqual(await s.get(c.id), c);
        await rejectsWith(s.put({ ...c, body: 'changed body' }), 'conflict');
        assert.equal(await s.get('prc_01JC0000000000000000000000'), undefined);
      },
    },
  ];
}
