import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { PortError, verifyAuditChain } from '@autotest/core';
import {
  approvalStoreCases,
  auditSinkCases,
  idempotencyStoreCases,
  inventoryStoreCases,
  prContextStoreCases,
  profileStoreCases,
  decisionStoreCases,
  planStoreCases,
  resultStoreCases,
  runStoreCases,
  sampleApproval,
  samplePlan,
} from '@autotest/core/testing';
import { dataRootPaths } from '@autotest/storage';
import { freshRoot } from './helpers.ts';

const stores = () => freshRoot().open().stores;

describe('STO-003 SQLite repositories pass the shared port contract cases', () => {
  const cases = [
    ...planStoreCases(() => stores().plans),
    ...decisionStoreCases(() => stores().decisions),
    ...approvalStoreCases(() => stores().approvals),
    ...runStoreCases(() => stores().runs),
    ...resultStoreCases(() => stores().results),
    ...auditSinkCases(() => stores().audit),
    ...idempotencyStoreCases(() => stores().idempotency),
    ...profileStoreCases(() => stores().profiles),
    ...inventoryStoreCases(() => stores().inventories),
    ...prContextStoreCases(() => stores().prContexts),
  ];
  for (const c of cases) it(c.name, c.run);
});

describe('STO-003 integrity on load', () => {
  it('a tampered plan snapshot is detected (E_PLAN_HASH_MISMATCH path)', async () => {
    const { root, open } = freshRoot();
    const { stores: s } = open();
    const p = samplePlan();
    await s.plans.put(p);
    const file = dataRootPaths(root).planSnapshot(p.id, p.planHash);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Pump SavedSearchBadge', 'Pump Something Else'));
    await expect(s.plans.get(p.id)).rejects.toMatchObject({ code: 'integrity' });
  });

  it('a plan whose planHash does not match its content is refused on put', async () => {
    const { stores: s } = freshRoot().open();
    const p = samplePlan();
    await expect(
      s.plans.put({ ...p, testCases: [{ ...p.testCases[0]!, title: 'changed after hashing' }] }),
    ).rejects.toBeInstanceOf(PortError);
  });

  it('a tampered approval file makes the approval unusable (fail closed)', async () => {
    const { root, open } = freshRoot();
    const { stores: s } = open();
    const a = sampleApproval();
    await s.approvals.putApproval(a);
    const file = dataRootPaths(root).approval(a.id);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"maxUses":3', '"maxUses":300'));
    await expect(s.approvals.getApproval(a.id)).rejects.toMatchObject({ code: 'integrity' });
    await expect(s.approvals.consume(a.id, new Date('2026-10-23T01:00:00Z'))).rejects.toMatchObject({
      code: 'integrity',
    });
  });

  it('approval files are mode 0600', async () => {
    const { root, open } = freshRoot();
    const a = sampleApproval();
    await open().stores.approvals.putApproval(a);
    expect(fs.statSync(dataRootPaths(root).approval(a.id)).mode & 0o777).toBe(0o600);
  });

  it('two processes-worth of connections never consume an approval beyond maxUses', async () => {
    const { root, open } = freshRoot();
    const { sql, stores: s } = open();
    const a = sampleApproval({ maxUses: 5 });
    await s.approvals.putApproval(a);
    sql.close();
    const counts = await Promise.all(
      [1, 2].map(
        () =>
          new Promise<number>((resolve, reject) => {
            const w = new Worker(new URL('./workers/consumer.ts', import.meta.url), {
              workerData: { root, id: a.id, attempts: 5 },
            });
            w.once('message', resolve);
            w.once('error', reject);
          }),
      ),
    );
    expect(counts[0]! + counts[1]!).toBe(5);
    const after = await open().stores.approvals.getApproval(a.id);
    expect([after?.uses, after?.state]).toEqual([5, 'consumed']);
  });

  it('the audit chain survives a reopen and detects tampering in the file', async () => {
    const { root, open } = freshRoot();
    const first = open().stores.audit;
    for (let i = 0; i < 3; i++)
      await first.append({
        ts: '2026-10-23T00:00:00Z',
        actor: 'server',
        kind: 'tool.call',
        subjectRefs: [],
        data: { tool: 'get_pr_context', toolCallId: `c${i}` },
      });
    const second = open().stores.audit;
    await second.append({
      ts: '2026-10-23T00:00:00Z',
      actor: 'cli',
      kind: 'approval.created',
      subjectRefs: [],
      data: {
        approvalId: 'appr_01JC9999999999999999999999',
        source: 'cli',
        assurance: 'AL2',
        scopeDigest: `sha256:${'d'.repeat(64)}`,
      },
    });
    expect(verifyAuditChain(await second.readAll())).toBe(-1);
    const file = dataRootPaths(root).auditFile('2026-10');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"toolCallId":"c1"', '"toolCallId":"c7"'));
    expect(verifyAuditChain(await second.readAll())).toBe(1);
  });
});
