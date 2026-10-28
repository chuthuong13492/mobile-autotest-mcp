import { describe, expect, it } from 'vitest';
import {
  loadPolicyConfig,
  loadPolicyObject,
  parseRepoConfig,
  parseYamlSafely,
  schemaFor,
  UnsafeYamlError,
} from '@autotest/policy';

const MINIMAL = 'version: 1\n';
const load = (text: string) => {
  const r = loadPolicyConfig(text);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.policy;
};
const issues = (text: string | undefined) => {
  const r = loadPolicyConfig(text);
  expect(r.ok).toBe(false);
  if (r.ok) return [];
  expect(r.error.error.code).toBe('E_POLICY_UNAVAILABLE');
  return ((r.error.error.details?.['issues'] ?? []) as { path: string; message: string }[]).map(
    (i) => `${i.path} ${i.message}`,
  );
};

describe('POL-001 policy config', () => {
  it('applies documented defaults', () => {
    const { config } = load(MINIMAL);
    expect(config.coverageGate.thresholds).toEqual({
      requirementCoverageMin: 1,
      testCaseCoverageMin: 1,
      platformCoverageMin: 0.8,
      regressionCoverageMin: 1,
    });
    expect(config.coverageGate.rules['GR-09']).toEqual({ enabled: true, depth: 2 });
    expect(config.coverageGate.exceptionMaxDays).toBe(30);
    expect(config.risk.defaultFactors).toMatchObject({
      functionalImpact: 3,
      regressionLikelihood: 3,
      changeSurface: 2,
    });
    expect(config.execution).toMatchObject({
      cancelGraceMs: 10_000,
      outputCapBytes: 50 * 1024 * 1024,
      runDiskQuotaBytes: 2 * 1024 ** 3,
      allowDependencyResolution: false,
    });
    expect(config.retention).toMatchObject({
      runArtifactsDays: 14,
      auditDays: 90,
      quarantineDays: 7,
      totalCapBytes: 5 * 1024 ** 3,
    });
    expect(config.approvals.allowWeakApprovals).toBe(false);
    expect(Object.isFrozen(config.coverageGate.rules)).toBe(true);
  });

  it('version digests are stable, sectioned and independent of key order and formatting', () => {
    const a = load(
      'version: 1\ncoverageGate:\n  thresholds: { platformCoverageMin: 0.5 }\nexecution: { maxRetries: 2 }\n',
    );
    const b = load('execution:\n  maxRetries: 2\nversion: 1\ncoverageGate: {thresholds: {platformCoverageMin: 0.5}}\n');
    expect([a.policyVersion, a.gatePolicyVersion, a.riskPolicyVersion]).toEqual([
      b.policyVersion,
      b.gatePolicyVersion,
      b.riskPolicyVersion,
    ]);
    const base = load(MINIMAL);
    expect(a.gatePolicyVersion).not.toBe(base.gatePolicyVersion);
    expect(a.riskPolicyVersion).toBe(base.riskPolicyVersion);
    expect(a.policyVersion).not.toBe(base.policyVersion);
    // explicit defaults hash the same as omitted defaults
    expect(load('version: 1\nrisk: { thresholds: { r0Max: 4, r1Max: 12, r2Max: 24 } }\n').riskPolicyVersion).toBe(
      base.riskPolicyVersion,
    );
    expect(base.policyVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('missing or invalid config is unavailable (fail safe)', () => {
    issues(undefined);
    issues('');
    expect(issues('version: 2\n').join()).toMatch(/\/version/);
    expect(issues('version: 1\nsurprise: true\n').join()).toMatch(/surprise|Unrecognized/i);
  });

  it('locked gate rules and GB rules cannot be disabled; thresholds stay in [0,1]', () => {
    expect(issues('version: 1\ncoverageGate: { rules: { GR-01: { enabled: false } } }\n').join()).toMatch(
      /GR-01.*locked/,
    );
    expect(issues('version: 1\ncoverageGate: { rules: { GR-07: { enabled: false } } }\n').join()).toMatch(
      /GR-07.*locked/,
    );
    expect(issues('version: 1\ncoverageGate: { rules: { GB-01: { enabled: false } } }\n').join()).toMatch(
      /GB-01|rules/,
    );
    expect(issues('version: 1\ncoverageGate: { thresholds: { requirementCoverageMin: 1.5 } }\n').join()).toMatch(
      /requirementCoverageMin/,
    );
    expect(issues('version: 1\ncoverageGate: { exceptionMaxDays: 90 }\n').join()).toMatch(/exceptionMaxDays/);
    expect(
      load('version: 1\ncoverageGate: { rules: { GR-03: { enabled: false } } }\n').config.coverageGate.rules['GR-03']
        .enabled,
    ).toBe(false);
  });

  it('approval minimums are upward-only unless allowWeakApprovals; CI device actions are locked', () => {
    expect(issues('version: 1\napprovals: { minAssurance: { plan_execution: { local: AL1 } } }\n').join()).toMatch(
      /allowWeakApprovals/,
    );
    expect(
      load('version: 1\napprovals: { allowWeakApprovals: true, minAssurance: { plan_execution: { local: AL1 } } }\n')
        .config.approvals.minAssurance.plan_execution?.local,
    ).toBe('AL1');
    expect(
      load('version: 1\napprovals: { minAssurance: { github_publish: { local: AL3 } } }\n').config.approvals
        .minAssurance.github_publish?.local,
    ).toBe('AL3');
    expect(
      issues(
        'version: 1\napprovals: { allowWeakApprovals: true, minAssurance: { device_action: { ci: AL3 } } }\n',
      ).join(),
    ).toMatch(/locked/);
  });

  it('rejects executables without a built-in schema, dangerous env names and unscoped secrets', () => {
    expect(issues('version: 1\nexecutables: { bash: { path: /bin/bash } }\n').join()).toMatch(/executables\/bash/);
    expect(issues('version: 1\nexecutables: { flutter: { path: relative/flutter } }\n').join()).toMatch(/absolute/);
    for (const n of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'PATH', 'HOME']) {
      expect(issues(`version: 1\nenv: { allow: [${n}] }\n`).length).toBeGreaterThan(0);
    }
    expect(
      issues('version: 1\nenv: { secrets: [{ name: TEST_PW, ref: "env:TEST_PW", workspaces: [ws_nope] }] }\n').join(),
    ).toMatch(/unknown workspace/);
    expect(
      issues(
        'version: 1\nenv: { secrets: [{ name: TEST_PW, ref: "file:/etc/passwd", workspaces: [ws_a] }] }\nworkspaces: [{ id: ws_a, path: /tmp }]\n',
      ).join(),
    ).toMatch(/ref/);
    expect(issues('version: 1\nworkspaces: [{ id: ws_a, path: /a }, { id: ws_a, path: /b }]\n').join()).toMatch(
      /duplicate/,
    );
  });

  it('1.3.0 workspace run options: flavor and dart-defines, never secrets; they change the policy version', () => {
    const ws = (run: string) => `version: 1\nworkspaces: [{ id: ws_a, path: /tmp, run: ${run} }]\n`;
    const a = load(ws('{ flutter: { flavor: staging, dartDefines: { ENV: staging } } }'));
    expect(a.config.workspaces[0]!.run).toEqual({ flutter: { flavor: 'staging', dartDefines: { ENV: 'staging' } } });
    const b = load(ws('{ flutter: { flavor: prod, dartDefines: { ENV: staging } } }'));
    expect(b.policyVersion).not.toBe(a.policyVersion);
    expect(issues(ws('{ flutter: { dartDefines: { NEWRELIC_API_KEY: x } } }')).join()).toMatch(/secret/);
    expect(issues(ws('{ flutter: { dartDefines: { AUTH_TOKEN: x } } }')).join()).toMatch(/secret/);
    expect(issues(ws('{ flutter: { flavor: "a b" } }')).length).toBeGreaterThan(0);
    expect(issues(ws('{ flutter: { dartDefines: { ENV: "a\\nb" } } }')).length).toBeGreaterThan(0);
    expect(issues(ws('{ gradle: {} }')).length).toBeGreaterThan(0);
  });

  it('B2: Flutter SDK aliases share the flutter schema; other aliases and unknown bindings are refused', () => {
    const two = 'executables:\n  "flutter@3.41.9": { path: /a/flutter }\n  "flutter@3.47.1": { path: /b/flutter }\n';
    const ok = load(`version: 1\n${two}workspaces: [{ id: ws_a, path: /tmp, flutterSdk: "flutter@3.47.1" }]\n`);
    expect(Object.keys(ok.config.executables)).toEqual(['flutter@3.41.9', 'flutter@3.47.1']);
    expect(schemaFor('flutter@3.47.1')).toBe(schemaFor('flutter'));
    expect(schemaFor('gh@other')).toBeUndefined();
    expect(schemaFor('bash@1')).toBeUndefined();
    expect(issues('version: 1\nexecutables: { "gh@x": { path: /usr/bin/gh } }\n').join()).toMatch(/executables\/gh@x/);
    expect(
      issues(`version: 1\n${two}workspaces: [{ id: ws_a, path: /tmp, flutterSdk: "flutter@9.9.9" }]\n`).join(),
    ).toMatch(/no executable flutter@9\.9\.9/);
  });

  it('loadPolicyObject validates plain objects too', () => {
    expect(loadPolicyObject({ version: 1 }).ok).toBe(true);
    expect(loadPolicyObject(null).ok).toBe(false);
  });
});

describe('POL-001 malicious YAML corpus', () => {
  const corpus: [string, string][] = [
    ['billion laughs', 'a: &a ["x","x"]\nb: &b [*a,*a]\nc: &c [*b,*b]\nd: [*c,*c]\n'],
    ['single alias', 'version: &v 1\nother: *v\n'],
    ['merge key', 'base: &b { version: 1 }\n<<: *b\n'],
    ['duplicate keys', 'version: 1\nversion: 1\n'],
    ['custom tag', 'version: !!js/function "function(){}"\n'],
    ['binary tag', 'version: !!binary aGVsbG8=\n'],
    ['oversized', `version: 1\n# ${'x'.repeat(300 * 1024)}\n`],
    ['complex key', '? [a, b]\n: 1\n'],
  ];
  for (const [name, text] of corpus) {
    it(`rejects: ${name}`, () => {
      expect(() => parseYamlSafely(text)).toThrow(UnsafeYamlError);
      expect(loadPolicyConfig(text).ok).toBe(false);
    });
  }

  it('__proto__ keys do not pollute prototypes and are rejected by the schema', () => {
    const r = loadPolicyConfig('version: 1\n__proto__: { polluted: true }\n');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(r.ok).toBe(false);
  });
});

describe('POL-001 repository config narrows only (T-20)', () => {
  it('keeps narrowing keys and reports every other key', () => {
    const r = parseRepoConfig(
      'excludePaths: [test/legacy/**]\nincludeTags: [smoke]\nexecutables: { flutter: { path: /tmp/evil } }\napprovals: { allowWeakApprovals: true }\n',
    );
    expect(r.config).toEqual({ excludePaths: ['test/legacy/**'], includeTags: ['smoke'], excludeTags: [] });
    expect(r.rejectedKeys).toEqual(['executables', 'approvals']);
    expect(r.errors).toEqual([]);
  });

  it('a malformed or unsafe repo config narrows nothing and never throws', () => {
    for (const t of [
      'a: &a 1\nb: *a\n',
      '- just\n- a list\n',
      'includeTags: ["bad tag!"]\n',
      'excludeTags: !!binary aGVsbG8=\n',
    ]) {
      const r = parseRepoConfig(t);
      expect(r.config).toEqual({ excludePaths: [], includeTags: [], excludeTags: [] });
      expect(r.errors.length).toBeGreaterThan(0);
    }
    expect(parseRepoConfig(':\n  :').rejectedKeys).toEqual(['']);
    expect(parseRepoConfig(undefined).errors).toEqual([]);
    expect(parseRepoConfig('').errors).toEqual([]);
  });
});
