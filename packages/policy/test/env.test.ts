import { describe, expect, it } from 'vitest';
import { buildChildEnv, envSecretResolver, loadPolicyConfig, type ChildEnvRequest } from '@autotest/policy';

const policy = loadPolicyConfig(
  [
    'version: 1',
    'workspaces: [{ id: ws_app, path: /tmp/app }, { id: ws_other, path: /tmp/other }]',
    'env:',
    '  allow: [JAVA_HOME, ANDROID_HOME]',
    '  pathDirs: [/usr/bin, /bin]',
    '  secrets:',
    '    - { name: TEST_ACCOUNT_PASSWORD, ref: "env:AUTOTEST_TEST_PW", workspaces: [ws_app] }',
    '    - { name: OTHER_TOKEN, ref: "env:AUTOTEST_OTHER", workspaces: [ws_other] }',
    '    - { name: MISSING_SECRET, ref: "env:AUTOTEST_NOT_SET", workspaces: [ws_app] }',
    '    - { name: KEYCHAIN_SECRET, ref: "keychain:autotest/x", workspaces: [ws_app] }',
  ].join('\n'),
);
if (!policy.ok) throw new Error('fixture policy invalid');

const parentEnv = {
  PATH: '/opt/evil/bin:/usr/bin',
  HOME: '/Users/someone',
  JAVA_HOME: '/opt/jdk',
  CANARY_LEAK: 'canary-value-should-not-pass',
  GITHUB_TOKEN: 'synthetic-token-value',
  NODE_OPTIONS: '--require /tmp/x.js',
  AUTOTEST_TEST_PW: 'synthetic-password-1',
  AUTOTEST_OTHER: 'synthetic-other-2',
};
const req = (over: Partial<ChildEnvRequest> = {}): ChildEnvRequest => ({
  env: policy.policy.config.env,
  workspaceId: 'ws_app',
  needs: [],
  home: '/data/runs/run_x/home',
  tmpDir: '/data/tmp/run_x',
  executableDir: '/sdk/flutter/bin',
  parentEnv,
  resolver: envSecretResolver(parentEnv),
  ...over,
});

describe('POL-004 child environment', () => {
  it('builds from the allowlist; the parent environment is never inherited', async () => {
    const r = await buildChildEnv(req());
    expect(r).toEqual({
      ok: true,
      env: {
        PATH: '/sdk/flutter/bin:/usr/bin:/bin',
        HOME: '/data/runs/run_x/home',
        TMPDIR: '/data/tmp/run_x',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        JAVA_HOME: '/opt/jdk',
      },
      secretValues: [],
      secretNames: [],
    });
    const values = Object.values(r.ok ? r.env : {}).join('\n');
    for (const leaked of ['canary-value-should-not-pass', 'synthetic-token-value', '/opt/evil/bin', '--require'])
      expect(values).not.toContain(leaked);
  });

  it('delivers a scoped secret only when the spec needs it and returns it for the redactor', async () => {
    const r = await buildChildEnv(req({ needs: ['TEST_ACCOUNT_PASSWORD', 'JAVA_HOME'] }));
    expect(r.ok && r.env['TEST_ACCOUNT_PASSWORD']).toBe('synthetic-password-1');
    expect(r.ok && [r.secretValues, r.secretNames]).toEqual([['synthetic-password-1'], ['TEST_ACCOUNT_PASSWORD']]);
  });

  it('denies unscoped, unknown and unavailable needs', async () => {
    expect(await buildChildEnv(req({ needs: ['OTHER_TOKEN'] }))).toEqual({
      ok: false,
      denials: [{ code: 'secret_not_scoped', name: 'OTHER_TOKEN' }],
    });
    expect(await buildChildEnv(req({ needs: ['GITHUB_TOKEN'] }))).toEqual({
      ok: false,
      denials: [{ code: 'env_not_allowed', name: 'GITHUB_TOKEN' }],
    });
    expect(await buildChildEnv(req({ needs: ['MISSING_SECRET', 'KEYCHAIN_SECRET'] }))).toEqual({
      ok: false,
      denials: [
        { code: 'secret_unavailable', name: 'MISSING_SECRET' },
        { code: 'secret_unavailable', name: 'KEYCHAIN_SECRET' },
      ],
    });
  });

  it('the env resolver rejects other schemes', async () => {
    await expect(envSecretResolver({}).resolve('keychain:a/b')).rejects.toThrow(/unsupported/);
  });
});
