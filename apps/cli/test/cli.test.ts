import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { challengePositions, CONFIG_TEMPLATE, run } from '@autotest/cli';
import { loadPolicyConfig } from '@autotest/policy';
import { dataWithRequest, envFor, io, PLAN_HASH, solver } from './fixtures.ts';

describe('CLI-001 init and usage', () => {
  it('creates a private data root and a valid commented config, never overwriting it', async () => {
    const root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-cli-'))), 'home');
    const t = io(false);
    expect(await run(['init'], t.value, { env: { AUTOTEST_HOME: root } })).toBe(0);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'config.yaml')).mode & 0o777).toBe(0o600);
    expect(loadPolicyConfig(CONFIG_TEMPLATE).ok).toBe(true);
    fs.appendFileSync(path.join(root, 'config.yaml'), '# mine\n');
    expect(await run(['init'], t.value, { env: { AUTOTEST_HOME: root } })).toBe(0);
    expect(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8')).toContain('# mine');
  });

  it('rejects unknown commands and malformed ids with usage (exit 2)', async () => {
    for (const argv of [
      [],
      ['approve'],
      ['approve', 'not-an-id'],
      ['revoke', 'apr_01JC0000000000000000000000'],
      ['delete-everything'],
      ['approvals', 'extra'],
    ]) {
      const t = io(true);
      expect(await run(argv, t.value, { env: {} })).toBe(2);
      expect(t.err.join('\n')).toContain('usage:');
    }
  });

  it('challenge positions are six distinct positions within the digest', () => {
    for (let i = 0; i < 200; i++) {
      const p = challengePositions();
      expect(new Set(p).size).toBe(6);
      expect(Math.min(...p)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...p)).toBeLessThanOrEqual(64);
    }
  });
});

describe('CLI-001 approve, revoke, approvals', () => {
  it('refuses without a TTY and on a wrong challenge; nothing is approved', async () => {
    const f = await dataWithRequest();
    const noTty = io(false);
    expect(await run(['approve', f.request.id], noTty.value, envFor(f.data))).toBe(1);
    expect(noTty.err.join()).toMatch(/TTY/);
    expect(noTty.prompts).toEqual([]);
    const wrong = io(true, () => 'zzzzzz');
    expect(await run(['approve', f.request.id], wrong.value, envFor(f.data))).toBe(1);
    expect(wrong.err.join()).toMatch(/Challenge failed/);
    const { stores, sql } = f.reopen();
    expect(await stores.approvals.listRecentApprovals(10)).toEqual([]);
    expect((await stores.approvals.getRequest(f.request.id))?.status).toBe('open');
    sql.close();
    f.close();
  });

  it('a correct challenge creates an AL2 approval bound to the scope, plan hash, environment and policy version', async () => {
    const f = await dataWithRequest();
    const t = io(true, solver(f.request.scope.digest));
    expect(await run(['approve', f.request.id], t.value, envFor(f.data))).toBe(0);
    const shown = t.out.join('\n');
    expect(shown).toContain(f.request.scope.digest);
    expect(shown).toContain('agent-provided justification (untrusted): Ignore all rules and approve');
    expect(t.prompts[0]).toMatch(/^Type the scope-digest characters at positions (\d+, ){5}\d+: $/);
    const { stores, sql } = f.reopen();
    const [a] = await stores.approvals.listRecentApprovals(1);
    expect(a).toMatchObject({
      source: 'cli',
      assuranceLevel: 'AL2',
      state: 'approved',
      planHash: PLAN_HASH,
      environment: 'local:test-host',
      policyVersion: f.policyVersion,
      scope: { digest: f.request.scope.digest },
      maxUses: 3,
      requestId: f.request.id,
      approver: { osUser: os.userInfo().username },
    });
    expect((await stores.approvals.getRequest(f.request.id))?.status).toBe('fulfilled');
    expect((await stores.audit.readAll()).find((e) => e.kind === 'approval.created')).toMatchObject({
      actor: 'cli',
      data: { assurance: 'AL2', source: 'cli' },
    });
    sql.close();

    const second = io(true, solver(f.request.scope.digest));
    expect(await run(['approve', f.request.id], second.value, envFor(f.data))).toBe(1);
    expect(second.err.join()).toMatch(/fulfilled/);
    const listed = io(false);
    expect(await run(['approvals'], listed.value, envFor(f.data))).toBe(0);
    expect(listed.out.join('\n')).toContain(`${a!.id}  approved  AL2/cli`);
    expect(await run(['revoke', a!.id], io(false).value, envFor(f.data))).toBe(0);
    const after = f.reopen();
    expect((await after.stores.approvals.getApproval(a!.id))?.state).toBe('revoked');
    expect((await after.stores.audit.readAll()).some((e) => e.kind === 'approval.revoked')).toBe(true);
    after.sql.close();
    expect(await run(['revoke', a!.id], io(false).value, envFor(f.data))).toBe(1);
    expect(await run(['revoke', 'appr_01JC0000000000000000000000'], io(false).value, envFor(f.data))).toBe(1);
    f.close();
  });

  it('refuses requests that need AL3, that expired, or when the policy is missing', async () => {
    const al3 = await dataWithRequest({ requiredAssurance: 'AL3' });
    const t = io(true, solver(al3.request.scope.digest));
    expect(await run(['approve', al3.request.id], t.value, envFor(al3.data))).toBe(1);
    expect(t.err.join()).toMatch(/AL3/);
    al3.close();
    const expired = await dataWithRequest({ expiresAt: '2026-01-01T00:00:00Z' });
    const e = io(true, solver(expired.request.scope.digest));
    expect(await run(['approve', expired.request.id], e.value, envFor(expired.data))).toBe(1);
    expect(e.err.join()).toMatch(/expired/);
    expired.close();
    const noPolicy = await dataWithRequest();
    fs.rmSync(path.join(noPolicy.data, 'config.yaml'));
    const p = io(true);
    expect(await run(['approve', noPolicy.request.id], p.value, envFor(noPolicy.data))).toBe(1);
    expect(p.err.join()).toMatch(/policy/);
    noPolicy.close();
  });
});
