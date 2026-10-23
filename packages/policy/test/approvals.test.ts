import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Approval } from '@autotest/contracts';
import {
  NO_AL3,
  coverageExceptionScope,
  deviceActionScope,
  effectiveAssurance,
  githubPublishScope,
  matchPreauth,
  parsePreauthFile,
  planExecutionScope,
  scopeDigest,
  selectApproval,
  toAuthorizationReasons,
  verifyApproval,
  type ApprovalExpectation,
  type VerifyContext,
} from '@autotest/policy';
import { NOW, TT_A, TT_B, approvalFor, plan, policy } from './authFixtures.ts';

const pol = policy();
const p = plan();
const expectation = (targets = [TT_A, TT_B]): ApprovalExpectation => ({
  scope: planExecutionScope({ planHash: p.planHash, environment: 'local:host1', targetIds: targets }),
  planHash: p.planHash,
  environment: 'local:host1',
  policyVersion: pol.policyVersion,
});
const local: VerifyContext = { now: NOW, environmentKind: 'local', overrides: {}, al3: NO_AL3 };
const ci: VerifyContext = { ...local, environmentKind: 'ci' };
const reasons = (over: Record<string, unknown>, ctx = local, exp = expectation()) =>
  verifyApproval(approvalFor(p, pol, [TT_A, TT_B], over), exp, ctx).reasons;

describe('AUTH-002 scopes', () => {
  it('digests are canonical: target order and duplicates do not matter, content does', () => {
    const a = planExecutionScope({ planHash: p.planHash, environment: 'local:h', targetIds: [TT_B, TT_A, TT_A] });
    const b = planExecutionScope({ planHash: p.planHash, environment: 'local:h', targetIds: [TT_A, TT_B] });
    expect(a.digest).toBe(b.digest);
    expect(
      planExecutionScope({ planHash: p.planHash, environment: 'local:other', targetIds: [TT_A, TT_B] }).digest,
    ).not.toBe(a.digest);
    expect(planExecutionScope({ planHash: p.planHash, environment: 'local:h', targetIds: [TT_A] }).digest).not.toBe(
      a.digest,
    );
    expect(a.digest).toBe(scopeDigest('plan_execution', a.params));
    const d = deviceActionScope({ action: 'erase', deviceId: 'D1', hostId: 'h' });
    expect(d.digest).not.toBe(deviceActionScope({ action: 'erase', deviceId: 'D2', hostId: 'h' }).digest);
    const g = {
      host: 'github.com',
      owner: 'example',
      name: 'app',
      pr: 42,
      headSha: 'a'.repeat(40),
      reportHash: `sha256:${'f'.repeat(64)}`,
      mechanism: 'comment',
    };
    expect(githubPublishScope(g).digest).not.toBe(githubPublishScope({ ...g, mechanism: 'check_run' }).digest);
    const ex = { id: 'EXC-001', reason: 'not_testable', rationale: 'server-side only change, no client code' };
    expect(coverageExceptionScope({ planHash: p.planHash, exception: ex }).digest).toBe(
      coverageExceptionScope({ planHash: p.planHash, exception: { ...ex, approvalId: 'appr_x' } }).digest,
    );
    expect(
      coverageExceptionScope({ planHash: p.planHash, exception: { ...ex, rationale: 'changed rationale text here' } })
        .digest,
    ).not.toBe(coverageExceptionScope({ planHash: p.planHash, exception: ex }).digest);
  });
});

describe('AUTH-002 usability matrix', () => {
  it('a matching AL2 CLI approval is usable locally', () => {
    expect(verifyApproval(approvalFor(p, pol, [TT_A, TT_B]), expectation(), local)).toMatchObject({
      usable: true,
      effectiveAssurance: 'AL2',
      required: 'AL2',
    });
  });

  const matrix: [string, Record<string, unknown>, string[]][] = [
    ['revoked', { state: 'revoked', revokedAt: '2026-10-23T00:30:00Z', revokedBy: 'dev' }, ['revoked']],
    ['superseded', { state: 'superseded' }, ['superseded']],
    ['expired state', { state: 'expired' }, ['expired']],
    ['expired by time', { expiresAt: '2026-10-23T00:59:59Z' }, ['expired']],
    ['consumed', { state: 'consumed', uses: 3 }, ['exhausted']],
    ['uses exhausted', { uses: 3 }, ['exhausted']],
    ['pending', { state: 'pending' }, ['not_approved']],
    ['denied', { state: 'denied' }, ['not_approved']],
    ['other plan hash', { planHash: `v1:sha256:${'9'.repeat(64)}` }, ['stale_plan_hash']],
    ['other environment', { environment: 'local:host2' }, ['stale_environment']],
    ['other policy version', { policyVersion: `sha256:${'8'.repeat(64)}` }, ['stale_policy_version']],
    ['AL1 elicitation', { source: 'elicitation', assuranceLevel: 'AL1' }, ['assurance_insufficient']],
    ['preauth for plan execution', { source: 'preauth' }, ['source_not_allowed']],
  ];
  for (const [name, over, expected] of matrix) {
    it(`unusable: ${name}`, () => expect(reasons(over)).toEqual(expected));
  }

  it('scope mismatch and a forged digest are both detected', () => {
    expect(reasons({}, local, expectation([TT_A]))).toEqual(['scope_mismatch']);
    const forged = approvalFor(p, pol, [TT_A, TT_B]);
    const tampered = Approval.parse({
      ...forged,
      scope: { ...forged.scope, params: { ...forged.scope.params, environment: 'local:evil' } },
    });
    expect(verifyApproval(tampered, expectation(), local).reasons).toEqual(['scope_digest_invalid']);
  });

  it('AL3 claims count as AL2 unless verified; CI requires AL3', () => {
    const al3 = approvalFor(p, pol, [TT_A, TT_B], { assuranceLevel: 'AL3', signature: 'sig' });
    expect(effectiveAssurance(al3, NO_AL3)).toBe('AL2');
    expect(effectiveAssurance(al3, { verify: () => true })).toBe('AL3');
    expect(verifyApproval(al3, expectation(), ci).reasons).toEqual(['assurance_insufficient']);
    expect(verifyApproval(al3, expectation(), { ...ci, al3: { verify: () => true } }).usable).toBe(true);
  });

  it('AL1 is accepted only where policy explicitly lowered the minimum', () => {
    const al1 = approvalFor(p, pol, [TT_A, TT_B], { source: 'elicitation', assuranceLevel: 'AL1' });
    expect(
      verifyApproval(al1, expectation(), { ...local, overrides: { plan_execution: { local: 'AL1' } } }).usable,
    ).toBe(true);
  });

  it('device actions are not allowed in CI whatever the approval', () => {
    const d = deviceActionScope({ action: 'erase', deviceId: 'D1', hostId: 'h' });
    const a = approvalFor(p, pol, [], { scope: d, planHash: undefined, assuranceLevel: 'AL3', signature: 's' });
    const r = verifyApproval(
      a,
      { scope: d, environment: 'local:host1', policyVersion: pol.policyVersion },
      { ...ci, al3: { verify: () => true } },
    );
    expect(r.reasons).toEqual(['not_allowed_in_environment']);
  });

  it('pre-authorization satisfies publication scopes, including in CI', () => {
    const g = githubPublishScope({
      host: 'github.com',
      owner: 'example',
      name: 'app',
      pr: 1,
      headSha: 'a'.repeat(40),
      reportHash: `sha256:${'f'.repeat(64)}`,
      mechanism: 'comment',
    });
    const a = approvalFor(p, pol, [], { scope: g, planHash: undefined, source: 'preauth', maxUses: 1 });
    const exp = { scope: g, environment: 'local:host1', policyVersion: pol.policyVersion };
    expect(verifyApproval(a, exp, local).usable).toBe(true);
    expect(verifyApproval(a, exp, ci).usable).toBe(true);
  });

  it('maps reasons to authorization codes and selects the oldest usable approval', () => {
    expect(toAuthorizationReasons(['expired', 'stale_plan_hash', 'scope_mismatch', 'assurance_insufficient'])).toEqual([
      'approval_expired',
      'approval_stale',
      'assurance_insufficient',
    ]);
    const old = approvalFor(p, pol, [TT_A, TT_B], {
      id: 'appr_01JC1111111111111111111111',
      createdAt: '2026-10-23T00:01:00Z',
    });
    const newer = approvalFor(p, pol, [TT_A, TT_B], {
      id: 'appr_01JC2222222222222222222222',
      createdAt: '2026-10-23T00:02:00Z',
    });
    const revoked = approvalFor(p, pol, [TT_A, TT_B], { id: 'appr_01JC0000000000000000000000', state: 'revoked' });
    expect(selectApproval([newer, revoked, old], expectation(), local).approval?.id).toBe(old.id);
    expect(selectApproval([revoked], expectation(), local).reasons).toEqual(['approval_revoked']);
    expect(selectApproval([], expectation(), local).reasons).toEqual(['approval_required']);
  });

  it('property: any single binding change makes a usable approval unusable', () => {
    const base = approvalFor(p, pol, [TT_A, TT_B]);
    fc.assert(
      fc.property(
        fc.constantFrom('planHash', 'environment', 'policyVersion', 'expiresAt', 'uses', 'state'),
        (field) => {
          const changed: Record<string, unknown> = {
            planHash: `v1:sha256:${'2'.repeat(64)}`,
            environment: 'local:x',
            policyVersion: `sha256:${'3'.repeat(64)}`,
            expiresAt: '2026-10-23T00:00:01Z',
            uses: 3,
            state: 'superseded',
          };
          return !verifyApproval(Approval.parse({ ...base, [field]: changed[field] }), expectation(), local).usable;
        },
      ),
    );
  });
});

describe('AUTH-002 pre-authorization file', () => {
  const file = [
    'version: 1',
    'entries:',
    '  - id: publish-app',
    '    scope: github_publish',
    '    environment: local:host1',
    '    match: { host: github.com, owner: example, name: app, mechanisms: [comment, check_run] }',
    '    expiresAt: "2026-12-31T00:00:00Z"',
  ].join('\n');

  it('parses entries and matches exactly', () => {
    const r = parsePreauthFile(file);
    expect(r.errors).toEqual([]);
    expect(r.fileDigest).toMatch(/^sha256:/);
    const t = { host: 'github.com', owner: 'example', name: 'app', mechanism: 'comment', environment: 'local:host1' };
    expect(matchPreauth(r.entries, t, NOW)?.id).toBe('publish-app');
    expect(matchPreauth(r.entries, { ...t, mechanism: 'commit_status' }, NOW)).toBeUndefined();
    expect(matchPreauth(r.entries, { ...t, name: 'other' }, NOW)).toBeUndefined();
    expect(matchPreauth(r.entries, { ...t, environment: 'local:host2' }, NOW)).toBeUndefined();
    expect(matchPreauth(r.entries, t, new Date('2027-01-01T00:00:00Z'))).toBeUndefined();
  });

  it('pre-authorizes only publication; any invalid file pre-authorizes nothing', () => {
    expect(parsePreauthFile(file.replace('scope: github_publish', 'scope: plan_execution')).entries).toEqual([]);
    expect(
      parsePreauthFile(
        `${file}\n  - id: publish-app\n    scope: github_publish\n    environment: local:host1\n    match: { host: github.com, owner: example, name: app, mechanisms: [comment] }\n    expiresAt: "2026-12-31T00:00:00Z"`,
      ).errors[0],
    ).toMatch(/duplicate/);
    expect(parsePreauthFile('version: 1\nentries: &e []\nother: *e\n').entries).toEqual([]);
    expect(parsePreauthFile(undefined)).toEqual({ entries: [], errors: [] });
  });
});
