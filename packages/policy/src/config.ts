/**
 * User policy config: schema, defaults, safe YAML loading and versioning (POL-001; SR-006, FR-019; ADR-0006; T-20).
 *
 * - The config lives outside any repository (`~/.autotest/config.yaml`). A missing or invalid config is
 *   `E_POLICY_UNAVAILABLE`, which denies execution (fail safe).
 * - Locked rules cannot be disabled: no GB rule is configurable, and GR-01/GR-07 accept only `enabled: true`.
 * - `policyVersion` is the digest of the whole canonical config after defaults; `gatePolicyVersion` and
 *   `riskPolicyVersion` digest the `coverageGate` and `risk` sections. Any change makes bound decisions and
 *   approvals stale, which is intended.
 * - The repository-local `.autotest.yaml` may only narrow scope (`parseRepoConfig`); every other key is rejected and
 *   reported for audit.
 */
import { z } from 'zod';
import { AssuranceLevel, RepositoryIdentity, Sha256, digest, toolError, type ToolError } from '@autotest/contracts';
import { isAlias, isCollection, isScalar, parseDocument, visit } from 'yaml';
import { schemaFor } from './argschemas/index.ts';
import { checkAssuranceOverrides } from './tiers.ts';

const MAX_CONFIG_BYTES = 256 * 1024;

const AbsPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) => p.startsWith('/') && !p.includes('\0') && !p.split('/').includes('..'),
    'must be an absolute path without ..',
  );

export const WorkspaceId = z.string().regex(/^ws_[a-z0-9_]{1,60}$/, 'expected ws_<lowercase id>');

const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/);
/** Variables that change how interpreters or loaders behave; never allowlisted (T-05, SR-004). */
const DANGEROUS_ENV =
  /^(LD_|DYLD_)|^(NODE_OPTIONS|BASH_ENV|ENV|PROMPT_COMMAND|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GIT_SSH_COMMAND|GIT_EXEC_PATH|SHELLOPTS|IFS)$/;
/** Names that the base environment owns; allowlisting them would let the parent environment override isolation. */
export const RESERVED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

export const SecretRef = z
  .string()
  .regex(
    /^(keychain:[A-Za-z0-9._/-]{1,200}|env:[A-Z_][A-Z0-9_]{0,63})$/,
    'expected keychain:<service/account> or env:<NAME>',
  );

/** Keys that look like credentials: they must not be compiled into a test build as dart-defines. */
const SECRET_LIKE_DEFINE = /(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL)/i;

/**
 * Per-workspace run options (1.3.0): `flutter test --flavor <flavor> --dart-define K=V …` for every Flutter run of
 * this workspace. They live in the user config, outside the repository (T-20), and are part of the policy version, so
 * changing them makes existing approvals stale. Values are plain text in argv and compiled into the app: secrets are
 * refused here.
 */
const WorkspaceRun = z.strictObject({
  flutter: z
    .strictObject({
      flavor: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/)
        .optional(),
      dartDefines: z
        .record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/),
          z
            .string()
            .max(500)
            .regex(/^[^\0\n\r]*$/),
        )
        .refine((r) => Object.keys(r).length <= 50, 'at most 50 dart-defines')
        .refine(
          (r) => !Object.keys(r).some((k) => SECRET_LIKE_DEFINE.test(k)),
          'a key looks like a secret: dart-defines are compiled into the app and visible in argv, not for credentials',
        )
        .optional(),
    })
    .optional(),
});
export type WorkspaceRunOptions = z.infer<typeof WorkspaceRun>;

const Workspace = z.strictObject({
  id: WorkspaceId,
  path: AbsPath,
  github: RepositoryIdentity.optional(),
  run: WorkspaceRun.optional(),
  /**
   * B2 (1.4.0): the Flutter SDK this workspace runs with, `flutter` or an alias such as `flutter@3.47.1` from
   * `executables`. Without it the adapter selects one from the workspace's pins; it never falls back silently.
   */
  flutterSdk: z
    .string()
    .regex(/^flutter(?:@[A-Za-z0-9._-]{1,32})?$/)
    .optional(),
  /** Inspection only: run_tests denies with workspace_not_allowed. */
  readOnlyReference: z.boolean().default(false),
});

const Executable = z.strictObject({ path: AbsPath, sha256: Sha256.optional() });

const Env = z.strictObject({
  allow: z
    .array(
      EnvName.refine((n) => !DANGEROUS_ENV.test(n), 'variable may not be allowlisted').refine(
        (n) => !(RESERVED_ENV as readonly string[]).includes(n),
        'reserved variable',
      ),
    )
    .max(100)
    .default([]),
  secrets: z
    .array(
      z.strictObject({
        name: EnvName.refine(
          (n) => !DANGEROUS_ENV.test(n) && !(RESERVED_ENV as readonly string[]).includes(n),
          'invalid secret name',
        ),
        ref: SecretRef,
        workspaces: z.array(WorkspaceId).min(1).max(50),
      }),
    )
    .max(50)
    .default([]),
  /** Directories that form the child PATH (the resolved executable's directory is added automatically). */
  pathDirs: z.array(AbsPath).min(1).max(20).default(['/usr/bin', '/bin', '/usr/sbin', '/sbin']),
  locale: z
    .string()
    .regex(/^[A-Za-z_]{2,10}(\.[A-Za-z0-9-]{1,20})?$/)
    .default('en_US.UTF-8'),
});

const Factor = (min: number, max: number) => z.number().int().min(min).max(max);
const Risk = z.strictObject({
  thresholds: z
    .strictObject({
      r0Max: z.number().int().min(1).max(48).default(4),
      r1Max: z.number().int().min(1).max(48).default(12),
      r2Max: z.number().int().min(1).max(48).default(24),
    })
    .default({ r0Max: 4, r1Max: 12, r2Max: 24 })
    .refine((t) => t.r0Max < t.r1Max && t.r1Max < t.r2Max, 'thresholds must increase'),
  defaultFactors: z
    .strictObject({
      functionalImpact: Factor(1, 4).default(3),
      securityPrivacyImpact: Factor(1, 4).default(2),
      dataIntegrityImpact: Factor(1, 4).default(2),
      criticalJourney: z.boolean().default(false),
      regressionLikelihood: Factor(1, 4).default(3),
      changeSurface: Factor(1, 3).default(2),
      uncertainty: Factor(1, 3).default(2),
      platformSpecificity: Factor(1, 2).default(1),
    })
    .default({
      functionalImpact: 3,
      securityPrivacyImpact: 2,
      dataIntegrityImpact: 2,
      criticalJourney: false,
      regressionLikelihood: 3,
      changeSurface: 2,
      uncertainty: 2,
      platformSpecificity: 1,
    }),
  criticalJourneys: z.array(z.string().min(1).max(100)).max(50).default([]),
});

const OnOff = z.strictObject({ enabled: z.boolean().default(true) });
const Locked = z.strictObject({ enabled: z.literal(true, { error: 'locked rule: cannot be disabled' }).default(true) });
const Ratio = z.number().min(0).max(1);
const DEFAULT_VAGUE = ['works', 'correctly', 'properly', 'as expected', 'is fine', 'no issues', 'looks good'];
const DEFAULT_OBSERVABLE = ['shows', 'hides', 'returns', 'navigates', 'emits', 'equals', 'contains', 'is disabled'];

const CoverageGate = z.strictObject({
  thresholds: z
    .strictObject({
      requirementCoverageMin: Ratio.default(1),
      testCaseCoverageMin: Ratio.default(1),
      platformCoverageMin: Ratio.default(0.8),
      regressionCoverageMin: Ratio.default(1),
    })
    .default({ requirementCoverageMin: 1, testCaseCoverageMin: 1, platformCoverageMin: 0.8, regressionCoverageMin: 1 }),
  /** Only GR rules appear here; GB rules are not configurable, so any GB key is an unrecognized key. */
  rules: z
    .strictObject({
      'GR-01': Locked.default({ enabled: true }),
      'GR-02': z
        .strictObject({
          enabled: z.boolean().default(true),
          vagueTerms: z.array(z.string().min(1).max(50)).max(100).default(DEFAULT_VAGUE),
          observableVerbs: z.array(z.string().min(1).max(50)).max(100).default(DEFAULT_OBSERVABLE),
        })
        .default({ enabled: true, vagueTerms: DEFAULT_VAGUE, observableVerbs: DEFAULT_OBSERVABLE }),
      'GR-03': OnOff.default({ enabled: true }),
      'GR-05': OnOff.default({ enabled: true }),
      'GR-06': OnOff.default({ enabled: true }),
      'GR-07': Locked.default({ enabled: true }),
      'GR-08': OnOff.default({ enabled: true }),
      'GR-09': z
        .strictObject({ enabled: z.boolean().default(true), depth: z.number().int().min(1).max(6).default(2) })
        .default({ enabled: true, depth: 2 }),
      'GR-10': z.strictObject({ promote: z.boolean().default(false) }).default({ promote: false }),
    })
    .default({
      'GR-01': { enabled: true },
      'GR-02': { enabled: true, vagueTerms: DEFAULT_VAGUE, observableVerbs: DEFAULT_OBSERVABLE },
      'GR-03': { enabled: true },
      'GR-05': { enabled: true },
      'GR-06': { enabled: true },
      'GR-07': { enabled: true },
      'GR-08': { enabled: true },
      'GR-09': { enabled: true, depth: 2 },
      'GR-10': { promote: false },
    }),
  exceptionMaxDays: z.number().int().min(1).max(30).default(30),
});

const Requirement = z.union([AssuranceLevel, z.enum(['none', 'not_allowed'])]);
const EnvRequirements = z.strictObject({ local: Requirement.optional(), ci: Requirement.optional() });
/** B3 (1.4.0): devices AutoTest creates; acquire reuses and adopts before it creates, up to this many per platform. */
const Devices = z.strictObject({
  maxOwned: z.number().int().min(1).max(10).default(2),
});

const Approvals = z.strictObject({
  allowWeakApprovals: z.boolean().default(false),
  minAssurance: z
    .strictObject({
      plan_execution: EnvRequirements.optional(),
      coverage_exception: EnvRequirements.optional(),
      device_action: EnvRequirements.optional(),
      github_publish: EnvRequirements.optional(),
    })
    .default({}),
});

const MiB = 1024 * 1024;
const Execution = z.strictObject({
  maxConcurrentRuns: z.number().int().min(1).max(8).default(1),
  maxRunsPerWorkspace: z.number().int().min(1).max(8).default(1),
  maxRunsPerDevice: z.number().int().min(1).max(4).default(1),
  /** Queued runs beyond this are refused with E_QUEUE_FULL (mcp-tool-contracts §3). */
  queueCapacity: z.number().int().min(1).max(200).default(20),
  defaultTimeoutMs: z.number().int().min(1000).max(14_400_000).default(1_800_000),
  maxRetries: z.number().int().min(0).max(3).default(1),
  cancelGraceMs: z.number().int().min(1000).max(120_000).default(10_000),
  outputCapBytes: z
    .number()
    .int()
    .min(MiB)
    .max(1024 * MiB)
    .default(50 * MiB),
  runDiskQuotaBytes: z
    .number()
    .int()
    .min(64 * MiB)
    .max(64 * 1024 * MiB)
    .default(2048 * MiB),
  /** The one always-prohibited item a config change can enable (threat model §Always prohibited). */
  allowDependencyResolution: z.boolean().default(false),
});

const Days = (d: number) => z.number().int().min(1).max(3650).default(d);
const Retention = z.strictObject({
  runArtifactsDays: Days(14),
  runRowsDays: Days(90),
  plansDays: Days(30),
  approvalsDaysAfterExpiry: Days(90),
  auditDays: Days(90),
  quarantineDays: Days(7),
  totalCapBytes: z
    .number()
    .int()
    .min(256 * MiB)
    .default(5 * 1024 * MiB),
});

const GitHub = z.strictObject({
  hosts: z
    .array(
      z.strictObject({
        host: z.string().regex(/^[a-z0-9.-]{1,253}$/),
        apiBaseUrl: z.url({ protocol: /^https$/ }).optional(),
        credentialRef: SecretRef.optional(),
      }),
    )
    .max(10)
    .default([{ host: 'github.com' }]),
  publication: z
    .strictObject({
      enabled: z.boolean().default(false),
      mechanisms: z
        .array(z.enum(['comment', 'check_run', 'commit_status']))
        .max(3)
        .default([]),
    })
    .default({ enabled: false, mechanisms: [] }),
});

const SECTION_DEFAULTS = { workspaces: [], executables: {} } as const;

export const PolicyConfig = z
  .strictObject({
    version: z.literal(1),
    workspaces: z
      .array(Workspace)
      .max(100)
      .default([...SECTION_DEFAULTS.workspaces]),
    executables: z.record(z.string(), Executable).default({ ...SECTION_DEFAULTS.executables }),
    env: Env.default(() => Env.parse({})),
    risk: Risk.default(() => Risk.parse({})),
    coverageGate: CoverageGate.default(() => CoverageGate.parse({})),
    approvals: Approvals.default(() => Approvals.parse({})),
    devices: Devices.default(() => Devices.parse({})),
    execution: Execution.default(() => Execution.parse({})),
    retention: Retention.default(() => Retention.parse({})),
    github: GitHub.default(() => GitHub.parse({})),
  })
  .superRefine((c, ctx) => {
    for (const name of Object.keys(c.executables)) {
      if (!schemaFor(name))
        ctx.addIssue({
          code: 'custom',
          path: ['executables', name],
          message: 'no built-in argument schema for this executable',
        });
    }
    const ids = new Set<string>();
    for (const [i, w] of c.workspaces.entries()) {
      if (ids.has(w.id))
        ctx.addIssue({ code: 'custom', path: ['workspaces', i, 'id'], message: 'duplicate workspace id' });
      ids.add(w.id);
      if (w.flutterSdk && !(w.flutterSdk in c.executables))
        ctx.addIssue({
          code: 'custom',
          path: ['workspaces', i, 'flutterSdk'],
          message: `no executable ${w.flutterSdk} is configured`,
        });
    }
    for (const [i, s] of c.env.secrets.entries()) {
      for (const ws of s.workspaces)
        if (!ids.has(ws))
          ctx.addIssue({
            code: 'custom',
            path: ['env', 'secrets', i, 'workspaces'],
            message: `unknown workspace ${ws}`,
          });
    }
    for (const v of checkAssuranceOverrides(c.approvals.minAssurance, c.approvals.allowWeakApprovals)) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvals', 'minAssurance', v.scopeKind, v.environment],
        message:
          v.reason === 'locked'
            ? 'locked: cannot be changed'
            : 'lowering below the default requires allowWeakApprovals: true',
      });
    }
    if (c.github.publication.enabled && c.github.publication.mechanisms.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['github', 'publication', 'mechanisms'],
        message: 'publication enabled without a mechanism',
      });
    }
  });
export type PolicyConfig = z.infer<typeof PolicyConfig>;

/** A validated, frozen policy and its version digests. */
export interface LoadedPolicy {
  readonly config: PolicyConfig;
  readonly policyVersion: `sha256:${string}`;
  readonly gatePolicyVersion: `sha256:${string}`;
  readonly riskPolicyVersion: `sha256:${string}`;
}

export type PolicyLoadResult =
  { readonly ok: true; readonly policy: LoadedPolicy } | { readonly ok: false; readonly error: ToolError };

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

/** Thrown by {@link parseYamlSafely}; carries positions, never content. */
export class UnsafeYamlError extends Error {
  override readonly name = 'UnsafeYamlError';
}

/**
 * Parses YAML in a restricted mode: size-capped, core schema, no aliases (YAML-bomb defense), no explicit
 * tags (`!!binary`, custom tags), duplicate keys rejected, and warnings treated as errors.
 */
export function parseYamlSafely(text: string, maxBytes = MAX_CONFIG_BYTES): unknown {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new UnsafeYamlError(`config larger than ${maxBytes} bytes`);
  const doc = parseDocument(text, {
    schema: 'core',
    uniqueKeys: true,
    merge: false,
    prettyErrors: false,
    strict: true,
    stringKeys: true,
  });
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length > 0)
    throw new UnsafeYamlError(
      problems.map((p) => `${p.code} at ${p.linePos?.[0]?.line ?? '?'}:${p.linePos?.[0]?.col ?? '?'}`).join('; '),
    );
  let unsafe: string | undefined;
  visit(doc, (_key, node) => {
    if (isAlias(node)) unsafe = 'aliases are not allowed';
    else if ((isScalar(node) || isCollection(node)) && node.tag) unsafe = 'explicit tags are not allowed';
    return unsafe ? visit.BREAK : undefined;
  });
  if (unsafe) throw new UnsafeYamlError(unsafe);
  try {
    return doc.toJS({ maxAliasCount: 0 });
  } catch (e) {
    throw new UnsafeYamlError((e as Error).message.slice(0, 200));
  }
}

const unavailable = (message: string, issues: readonly ConfigIssue[] = []): PolicyLoadResult => ({
  ok: false,
  error: toolError(
    'E_POLICY_UNAVAILABLE',
    message,
    ['Fix ~/.autotest/config.yaml, then run `autotest doctor`.'],
    issues.length ? { issues: issues.slice(0, 50) } : undefined,
  ),
});

const toIssues = (e: z.ZodError): ConfigIssue[] =>
  e.issues.map((i) => ({ path: `/${i.path.map(String).join('/')}`, message: i.message.slice(0, 200) }));

/** Validates a parsed config object (no YAML). */
export function loadPolicyObject(raw: unknown): PolicyLoadResult {
  const parsed = PolicyConfig.safeParse(raw);
  if (!parsed.success) return unavailable('policy config is invalid', toIssues(parsed.error));
  const config = deepFreeze(parsed.data);
  return {
    ok: true,
    policy: Object.freeze({
      config,
      policyVersion: digest(config),
      gatePolicyVersion: digest(config.coverageGate),
      riskPolicyVersion: digest(config.risk),
    }),
  };
}

/** Loads the user config text. `undefined` (no file) is unavailable: execution is denied rather than defaulted. */
export function loadPolicyConfig(text: string | undefined): PolicyLoadResult {
  if (text === undefined) return unavailable('policy config not found');
  let raw: unknown;
  try {
    raw = parseYamlSafely(text);
  } catch (e) {
    return unavailable(`policy config could not be parsed: ${(e as Error).message}`);
  }
  return loadPolicyObject(raw);
}

/** The narrowing-only repository config (`.autotest.yaml`). */
export const RepoConfig = z.strictObject({
  excludePaths: z
    .array(
      z
        .string()
        .min(1)
        .max(300)
        .refine((p) => !p.includes('\0')),
    )
    .max(100)
    .default([]),
  includeTags: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,50}$/))
    .max(50)
    .default([]),
  excludeTags: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,50}$/))
    .max(50)
    .default([]),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

export interface RepoConfigResult {
  readonly config: RepoConfig;
  /** Top-level keys that were ignored because they are not narrowing keys (to be audited, T-20). */
  readonly rejectedKeys: readonly string[];
  /** Problems that made the whole file (or a narrowing key) unusable; the file then narrows nothing. */
  readonly errors: readonly string[];
}

const NARROWING_KEYS = new Set(Object.keys(RepoConfig.shape));

/** Parses repository-provided config. Never throws and never widens: unknown keys are dropped and reported. */
export function parseRepoConfig(text: string | undefined): RepoConfigResult {
  const empty = RepoConfig.parse({});
  if (text === undefined) return { config: empty, rejectedKeys: [], errors: [] };
  let raw: unknown;
  try {
    raw = parseYamlSafely(text, 64 * 1024);
  } catch (e) {
    return { config: empty, rejectedKeys: [], errors: [(e as Error).message] };
  }
  if (raw === null || raw === undefined) return { config: empty, rejectedKeys: [], errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { config: empty, rejectedKeys: [], errors: ['top level must be a mapping'] };
  const entries = Object.entries(raw as Record<string, unknown>);
  const rejectedKeys = entries.filter(([k]) => !NARROWING_KEYS.has(k)).map(([k]) => k.slice(0, 100));
  const parsed = RepoConfig.safeParse(Object.fromEntries(entries.filter(([k]) => NARROWING_KEYS.has(k))));
  if (!parsed.success)
    return { config: empty, rejectedKeys, errors: toIssues(parsed.error).map((i) => `${i.path}: ${i.message}`) };
  return { config: parsed.data, rejectedKeys, errors: [] };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
