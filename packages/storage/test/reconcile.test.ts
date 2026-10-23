import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sampleApproval, sampleArtifact, samplePlan } from '@autotest/core/testing';
import { atomicWriteSync, dataRootPaths, reconcileStorage } from '@autotest/storage';
import { freshRoot } from './helpers.ts';

describe('STO-004 reconciliation', () => {
  it('handles every inconsistency kind, audits it, and is idempotent', async () => {
    const { root, open } = freshRoot();
    const { sql, stores } = open();
    const paths = dataRootPaths(root);

    // tmp leftover from an interrupted write
    expect(() =>
      atomicWriteSync(path.join(root, 'plans', 'x.json'), '{}', {
        beforeRename: () => {
          throw new Error('crash');
        },
      }),
    ).toThrow();
    // indexed plan whose snapshot is then deleted
    const gone = samplePlan();
    await stores.plans.put(gone);
    fs.rmSync(paths.planSnapshot(gone.id, gone.planHash));
    // valid orphan snapshot (written, row lost) → re-indexed
    const orphan = samplePlan({ id: 'plan_01JC7777777777777777777777', riskPolicyVersion: `sha256:${'c'.repeat(64)}` });
    const orphanFile = paths.planSnapshot(orphan.id, orphan.planHash);
    const { canonicalize } = await import('@autotest/core');
    atomicWriteSync(orphanFile, canonicalize(orphan));
    // invalid orphan snapshot → quarantined
    atomicWriteSync(path.join(root, 'plans', 'junk', 'v1_sha256_bad.json'), '{"not":"a plan"}');
    // orphan approval file → quarantined, never indexed
    atomicWriteSync(
      paths.approval('appr_01JC8888888888888888888888'),
      JSON.stringify(sampleApproval({ id: 'appr_01JC8888888888888888888888' })),
    );
    // approval whose file was modified
    const a = sampleApproval();
    await stores.approvals.putApproval(a);
    fs.appendFileSync(paths.approval(a.id), ' ');
    // artifact row whose file is missing
    await stores.artifacts.put(sampleArtifact());

    const actions = await reconcileStorage(sql, root, {
      audit: stores.audit,
      now: () => new Date('2026-10-23T00:00:00Z'),
    });
    const kinds = actions.map((x) => x.kind).sort();
    expect(kinds).toEqual([
      'approval_file_quarantined',
      'approval_integrity',
      'artifact_missing',
      'plan_indexed',
      'plan_quarantined',
      'plan_snapshot_missing',
      'tmp_removed',
    ]);
    expect((await stores.plans.get(orphan.id))?.planHash).toBe(orphan.planHash);
    expect(fs.existsSync(paths.approval('appr_01JC8888888888888888888888'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'quarantine', 'approvals'))).toHaveLength(1);
    expect(sql.get<{ status: string }>('SELECT status FROM artifacts')!.status).toBe('missing');
    expect((await stores.audit.readAll()).filter((e) => e.kind === 'reconciliation.action')).toHaveLength(7);

    const again = await reconcileStorage(sql, root);
    // Persistent integrity problems are re-reported; everything repairable is now clean.
    expect(again.map((x) => x.kind).sort()).toEqual(['approval_integrity', 'plan_snapshot_missing']);
  });
});
