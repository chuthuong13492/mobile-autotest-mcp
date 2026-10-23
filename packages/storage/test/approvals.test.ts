import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '@autotest/core';
import { sampleApproval } from '@autotest/core/testing';
import { dataRootPaths, reconcileStorage } from '@autotest/storage';
import { freshRoot } from './helpers.ts';

const at = new Date('2026-10-23T01:00:00Z');

describe('AUTH-001 approval store over SQLite', () => {
  it('a revocation by one connection takes effect immediately for another', async () => {
    const { open } = freshRoot();
    const first = open();
    const second = open();
    const a = sampleApproval();
    await first.stores.approvals.putApproval(a);
    await second.stores.approvals.revoke(a.id, 'dev', at);
    await expect(first.stores.approvals.consume(a.id, at)).rejects.toMatchObject({ code: 'not_usable' });
    expect((await first.stores.approvals.getApproval(a.id))?.revokedBy).toBe('dev');
  });

  it('a crash between the file write and the row update fails closed and is reported by reconciliation', async () => {
    const { root, open } = freshRoot();
    const { sql, stores } = open();
    const a = sampleApproval();
    await stores.approvals.putApproval(a);
    // Simulate the crash window: the authoritative file advanced, the index row did not.
    fs.writeFileSync(dataRootPaths(root).approval(a.id), canonicalize({ ...a, uses: 1 }));
    await expect(stores.approvals.consume(a.id, at)).rejects.toMatchObject({ code: 'integrity' });
    expect((await reconcileStorage(sql, root)).map((x) => x.kind)).toEqual(['approval_integrity']);
  });

  it('lazy expiry is durable across connections', async () => {
    const { open } = freshRoot();
    const a = sampleApproval({ expiresAt: '2026-10-23T00:30:00Z' });
    const first = open();
    await first.stores.approvals.putApproval(a);
    await expect(first.stores.approvals.consume(a.id, at)).rejects.toMatchObject({ code: 'not_usable' });
    expect((await open().stores.approvals.getApproval(a.id))?.state).toBe('expired');
  });
});
