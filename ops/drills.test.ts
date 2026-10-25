/**
 * OPS-007 operations drills: each recovery procedure of docs/operations-and-troubleshooting.md §4, performed as
 * written on a fresh data root with the fake runner, and checked. The log of the first drill is ops/drills-v1.md.
 * (Two §4 rows are drilled in the resilience suite: a session ending mid-run and a crashed server.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run as cli, type Io } from '@autotest/cli';
import { openDataRoot } from '@autotest/storage';
import {
  composeRuns,
  HOST_ENV,
  runnablePlan,
  sc,
  setupRunData,
  waitTerminal,
} from '../apps/mcp-server/test/runSetup.ts';

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});
async function autotest(data: string, args: string[], answer?: (prompt: string) => string) {
  const out: string[] = [];
  const io: Io = {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    out: (s) => void out.push(s),
    err: (s) => void out.push(s),
    ask: async (p) => answer?.(p) ?? '',
  };
  const code = await cli(args, io, { env: { ...HOST_ENV, AUTOTEST_HOME: data, HOME: path.dirname(data) } });
  return { code, text: out.join('\n') };
}
/** The human answering `autotest approve`'s challenge from the digest shown by request_approval. */
const challenge = (scopeDigest: string) => (p: string) =>
  /positions ([\d, ]+):/
    .exec(p)![1]!
    .split(',')
    .map((n) => scopeDigest.slice('sha256:'.length)[Number(n.trim()) - 1])
    .join('');
const err = (r: { structuredContent: Record<string, unknown> }) =>
  (r.structuredContent as { error?: { code: string } }).error?.code;

describe('OPS-007 operations drills (operations §4)', () => {
  it('cancel_pending: doctor lists the run and what to do', async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass' });
    const { sql, stores } = openDataRoot(f.data);
    await stores.runs.create({
      id: 'run_01JC000000000000000000000D',
      schemaVersion: 1,
      planId: 'plan_01JC0000000000000000000001',
      planHash: `v1:sha256:${'a'.repeat(64)}`,
      targets: [],
      environment: 'local:test-host',
      devices: [],
      state: 'cancel_pending',
      statusCategory: 'running',
      requestDigest: `sha256:${'b'.repeat(64)}`,
      authorizationIds: ['authz_01JC0000000000000000000001'],
      timeouts: { runMs: 60_000, attemptMs: 60_000, targetMs: 60_000 },
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      counts: {},
      partial: false,
      limitations: [],
      createdAt: '2026-10-25T00:00:00Z',
    });
    sql.close();
    const d = await autotest(f.data, ['doctor']);
    expect(d.text).toMatch(/WARN {2}runs\s+run_01JC000000000000000000000D is cancel_pending/);
    expect(d.text).toMatch(/end them manually/);
  });

  it(
    'E_STORAGE_CORRUPT (broken index): move autotest.db aside; a new index works, files stay',
    {
      timeout: 60_000,
    },
    async () => {
      const f = setupRunData({ 'test/a_test.dart': 'pass' });
      const c = await composeRuns(f.data);
      const plan = await runnablePlan(c, ['test/a_test.dart']);
      await c.close();
      // Damage the index: overwrite pages in the middle of the database file.
      const db = path.join(f.data, 'autotest.db');
      const fd = fs.openSync(db, 'r+');
      fs.writeSync(fd, Buffer.alloc(8192, 0x5a), 0, 8192, 8192);
      fs.closeSync(fd);
      expect((await autotest(f.data, ['doctor'])).text).toMatch(
        /FAIL {2}sqlite-index|database disk image is malformed/i,
      );
      // Procedure: stop the server (done), move the file aside, start again.
      fs.renameSync(db, `${db}.broken`);
      for (const ext of ['-wal', '-shm']) if (fs.existsSync(db + ext)) fs.renameSync(db + ext, `${db}.broken${ext}`);
      const doc = await autotest(f.data, ['doctor']);
      expect(doc.text).not.toMatch(/FAIL {2}sqlite-index/);
      expect(fs.readdirSync(path.join(f.data, 'plans'))).toContain(plan.planId);
      // The workflow runs again from the start.
      const c2 = await composeRuns(f.data);
      closers.push(() => c2.close());
      const again = await runnablePlan(c2, ['test/a_test.dart']);
      const { runId } = sc<{ runId: string }>(
        await c2.call('run_tests', { planId: again.planId, planHash: again.planHash }),
      );
      expect(await waitTerminal(c2, runId)).toMatchObject({ state: 'completed' });
    },
  );

  it('tampered approval file: unusable automatically; revoke and approve again', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass' });
    const c = await composeRuns(f.data);
    closers.push(() => c.close());
    const plan = await runnablePlan(c, ['test/a_test.dart'], { weak: true });
    expect(plan.decision).toBe('needs_review');
    const request = async () =>
      sc<{ approvalRequestId: string; scopeDigest: string }>(
        await c.call('request_approval', {
          scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
          justification: 'drill',
          offerElicitation: false,
        }),
      );
    const r1 = await request();
    expect((await autotest(f.data, ['approve', r1.approvalRequestId], challenge(r1.scopeDigest))).code).toBe(0);
    const file = fs.readdirSync(path.join(f.data, 'approvals'))[0]!;
    const p = path.join(f.data, 'approvals', file);
    const record = JSON.parse(fs.readFileSync(p, 'utf8')) as { maxUses: number };
    fs.writeFileSync(p, JSON.stringify({ ...record, maxUses: record.maxUses + 5 }));
    expect(err(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }))).toBe('E_STORAGE_CORRUPT');
    // Procedure: revoke it, approve again, review the audit log.
    const approvalId = file.replace(/\.json$/, '');
    const rv = await autotest(f.data, ['revoke', approvalId]);
    expect(rv.code, rv.text).toBe(0);
    const r2 = await request();
    expect((await autotest(f.data, ['approve', r2.approvalRequestId], challenge(r2.scopeDigest))).code).toBe(0);
    const ok = sc<{ runId: string }>(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
    expect(await waitTerminal(c, ok.runId)).toMatchObject({ state: 'completed' });
  });

  it(
    'audit chain broken: doctor --audit names the line; later reports carry a limitation',
    { timeout: 60_000 },
    async () => {
      const f = setupRunData({ 'test/a_test.dart': 'pass' });
      const c = await composeRuns(f.data);
      closers.push(() => c.close());
      const plan = await runnablePlan(c, ['test/a_test.dart']);
      const { runId } = sc<{ runId: string }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
      );
      await waitTerminal(c, runId);
      const dir = path.join(f.data, 'audit');
      const file = path.join(dir, fs.readdirSync(dir)[0]!);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines[2] = lines[2]!.replace('"actor":"agent"', '"actor":"cli"');
      fs.writeFileSync(file, lines.join('\n'));
      const a = await autotest(f.data, ['doctor', '--audit']);
      expect(a.code).toBe(1);
      expect(a.text).toMatch(/FAIL {2}audit-chain {2}hash_mismatch at \d{4}-\d{2}\.ndjson:3/);
      const rep = sc<{ limitations: { code: string }[] }>(
        await c.call('generate_pr_test_report', { planId: plan.planId, planHash: plan.planHash, runIds: [runId] }),
      );
      expect(rep.limitations.map((l) => l.code)).toContain('audit_chain_broken');
    },
  );

  it(
    'policy config invalid: execution is denied (E_POLICY_UNAVAILABLE); fixing it restores service',
    {
      timeout: 60_000,
    },
    async () => {
      const f = setupRunData({ 'test/a_test.dart': 'pass' });
      const cfg = path.join(f.data, 'config.yaml');
      const good = fs.readFileSync(cfg, 'utf8');
      fs.writeFileSync(cfg, `${good}execution: { maxParallelRuns: "lots" }\n`);
      const bad = await composeRuns(f.data);
      expect(
        err(
          await bad.call('get_pr_context', {
            workspace: 'ws_app',
            source: 'manual',
            manual: { title: 'x', body: '## Acceptance criteria\n- [ ] it shows "ok"\n' },
          }),
        ),
      ).toBe('E_POLICY_UNAVAILABLE');
      await bad.close();
      expect((await autotest(f.data, ['doctor'])).text).toMatch(/FAIL {2}config/);
      fs.writeFileSync(cfg, good);
      expect((await autotest(f.data, ['doctor'])).text).toMatch(/PASS {2}config/);
    },
  );

  it('disk usage high: cleanup --dry-run lists, cleanup removes exactly that', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass' });
    const c = await composeRuns(f.data);
    const plan = await runnablePlan(c, ['test/a_test.dart']);
    const { runId } = sc<{ runId: string }>(
      await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
    );
    await waitTerminal(c, runId);
    await c.close();
    const big = path.join(f.data, 'runs', runId, 'attempts', '1', 'big.log');
    // Real data: disk usage counts allocated space, so a sparse file would not count (the drills run one at a time).
    fs.writeFileSync(big, Buffer.alloc(300 * 1024 * 1024, 1));
    const cfg = path.join(f.data, 'config.yaml');
    fs.appendFileSync(cfg, 'retention: { totalCapBytes: 268435456 }\n');
    expect((await autotest(f.data, ['doctor'])).text).toMatch(/WARN {2}disk/);
    const dry = await autotest(f.data, ['cleanup', '--dry-run']);
    const { sql, stores } = openDataRoot(f.data);
    const row = await stores.runs.get(runId);
    sql.close();
    const diag = JSON.stringify({ state: row?.state, endedAt: row?.endedAt, cfg: fs.readFileSync(cfg, 'utf8') });
    expect(dry.text, diag).toMatch(new RegExp(`would remove run artifacts of ${runId} \\(cap`));
    expect(fs.existsSync(big)).toBe(true);
    const real = await autotest(f.data, ['cleanup']);
    expect(real.text).toMatch(new RegExp(`removed run artifacts of ${runId} \\(cap`));
    expect(fs.existsSync(big)).toBe(false);
    expect((await autotest(f.data, ['doctor'])).text).toMatch(/PASS {2}disk/);
  });
});
