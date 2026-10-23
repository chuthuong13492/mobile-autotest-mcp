import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@autotest/core';
import {
  InMemoryApprovalStore,
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  InMemoryInventoryStore,
  InMemoryPrContextStore,
  InMemoryProfileStore,
  InMemoryDecisionStore,
  InMemoryPlanStore,
  InMemoryResultStore,
  InMemoryRunStore,
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
} from '@autotest/core/testing';

const suites = [
  ...planStoreCases(() => new InMemoryPlanStore()),
  ...decisionStoreCases(() => new InMemoryDecisionStore()),
  ...approvalStoreCases(() => new InMemoryApprovalStore()),
  ...runStoreCases(() => new InMemoryRunStore()),
  ...resultStoreCases(() => new InMemoryResultStore()),
  ...auditSinkCases(() => new InMemoryAuditSink()),
  ...idempotencyStoreCases(() => new InMemoryIdempotencyStore()),
  ...profileStoreCases(() => new InMemoryProfileStore()),
  ...inventoryStoreCases(() => new InMemoryInventoryStore()),
  ...prContextStoreCases(() => new InMemoryPrContextStore()),
];

describe('CORE-004 port contract cases against in-memory fakes', () => {
  for (const c of suites) it(c.name, c.run);

  it('audit chain verification pinpoints tampering', async () => {
    const sink = new InMemoryAuditSink();
    for (let i = 0; i < 4; i++)
      await sink.append({
        ts: '2026-10-23T00:00:00Z',
        actor: 'cli',
        kind: 'approval.revoked',
        subjectRefs: [],
        data: { approvalId: `appr_${i}` },
      });
    sink.tamper(2, { data: { approvalId: 'appr_99' } });
    expect(verifyAuditChain(await sink.readAll())).toBe(2);
  });
});
