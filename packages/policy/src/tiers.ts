/**
 * Permission tiers and minimum approval assurance (POL-006; threat model §Permission tiers; ADR-0006 §2).
 *
 * The threat-model tier table and the ADR-0006 minimum-assurance table are canonical; docs-sync tests keep these
 * constants equal to them. Overrides may only raise a minimum, unless the user-owned config sets
 * `allowWeakApprovals: true`; entries whose default is `not_allowed` are locked.
 */
import {
  TOOLS,
  type ApprovalScopeKind,
  type PermissionTier,
  type SimulatorAction,
  type ToolName,
} from '@autotest/contracts';

export type PolicyEnvironment = 'local' | 'ci';

/** `none` = no approval needed; `not_allowed` = no approval can enable it in this environment. */
export type AssuranceRequirement = 'none' | 'AL1' | 'AL2' | 'AL3' | 'not_allowed';

const ORDER: readonly AssuranceRequirement[] = ['none', 'AL1', 'AL2', 'AL3', 'not_allowed'];

/** Compares two requirements; positive when `a` is stricter than `b`. */
export function compareAssurance(a: AssuranceRequirement, b: AssuranceRequirement): number {
  return ORDER.indexOf(a) - ORDER.indexOf(b);
}

/** ADR-0006 §2 defaults, keyed by approval scope kind. */
export const DEFAULT_MIN_ASSURANCE: Readonly<
  Record<ApprovalScopeKind, Readonly<Record<PolicyEnvironment, AssuranceRequirement>>>
> = {
  plan_execution: { local: 'AL2', ci: 'AL3' },
  coverage_exception: { local: 'AL2', ci: 'AL3' },
  device_action: { local: 'AL2', ci: 'not_allowed' },
  github_publish: { local: 'AL2', ci: 'AL3' },
};

/** Scope kinds for which a matching pre-authorization satisfies the requirement instead of an interactive approval. */
export const PREAUTH_SATISFIES: ReadonlySet<ApprovalScopeKind> = new Set(['github_publish']);

export type AssuranceOverrides = Partial<
  Record<ApprovalScopeKind, Partial<Record<PolicyEnvironment, AssuranceRequirement>>>
>;

export interface AssuranceViolation {
  readonly scopeKind: ApprovalScopeKind;
  readonly environment: PolicyEnvironment;
  readonly reason: 'locked' | 'weaker_than_default';
}

/** Returns every override that is not allowed: changes to locked entries, and lowering without `allowWeakApprovals`. */
export function checkAssuranceOverrides(
  overrides: AssuranceOverrides,
  allowWeakApprovals: boolean,
): AssuranceViolation[] {
  const out: AssuranceViolation[] = [];
  for (const [scopeKind, envs] of Object.entries(overrides) as [
    ApprovalScopeKind,
    AssuranceOverrides[ApprovalScopeKind],
  ][]) {
    for (const [environment, value] of Object.entries(envs ?? {}) as [PolicyEnvironment, AssuranceRequirement][]) {
      const dflt = DEFAULT_MIN_ASSURANCE[scopeKind][environment];
      if (dflt === 'not_allowed' && value !== 'not_allowed') out.push({ scopeKind, environment, reason: 'locked' });
      else if (compareAssurance(value, dflt) < 0 && !allowWeakApprovals)
        out.push({ scopeKind, environment, reason: 'weaker_than_default' });
    }
  }
  return out;
}

export interface MinAssurance {
  readonly required: AssuranceRequirement;
  readonly preauthSatisfies: boolean;
}

/** Effective minimum for a scope in an environment: the validated override, else the ADR-0006 default. */
export function minAssurance(
  scopeKind: ApprovalScopeKind,
  environment: PolicyEnvironment,
  overrides: AssuranceOverrides = {},
): MinAssurance {
  return {
    required: overrides[scopeKind]?.[environment] ?? DEFAULT_MIN_ASSURANCE[scopeKind][environment],
    preauthSatisfies: PREAUTH_SATISFIES.has(scopeKind),
  };
}

/** Context that decides the tier of tools whose tier varies per call (TL-14). */
export interface TierContext {
  readonly action?: SimulatorAction;
  /** True when the device was created by AutoTest and is leased to this server. */
  readonly owned?: boolean;
  readonly deviceKind?: 'simulator' | 'emulator' | 'physical';
}

/**
 * Tier of one tool call, or `prohibited` for always-prohibited actions. Unknown or under-specified context resolves
 * to the stricter tier.
 */
export function tierFor(tool: ToolName, context: TierContext = {}): PermissionTier | 'prohibited' {
  const contract = TOOLS.find((t) => t.name === tool);
  if (!contract) return 'prohibited';
  if (contract.tier.length === 1) return contract.tier[0]!;
  // TL-14 manage_simulator
  if (context.deviceKind === 'physical' && (context.action === 'erase' || context.action === 'delete'))
    return 'prohibited';
  if (context.action === 'create') return 'P1';
  return context.owned === true ? 'P1' : 'P2';
}

/** Threat model §Always prohibited. No approval enables these; only `dependency_resolution` is configurable. */
export const ALWAYS_PROHIBITED = [
  { id: 'arbitrary_command', summary: 'Arbitrary command execution' },
  { id: 'repo_write', summary: "Writing to the target repository's source tree" },
  { id: 'physical_device_erase', summary: 'Erasing, wiping or factory-resetting physical devices' },
  { id: 'publish_unredacted', summary: 'Publishing quarantined or unredacted artifacts' },
  { id: 'github_other_writes', summary: 'GitHub operations other than comment upsert' },
  { id: 'auto_approve_in_ci', summary: 'Auto-approving `needs_review` in CI' },
  { id: 'widen_from_repo', summary: 'Widening policy from repository-local configuration or from tool input' },
  { id: 'read_outside_roots', summary: 'Reading files outside allowlisted workspaces and the data root' },
  { id: 'dependency_resolution', summary: 'Installing dependencies from the network' },
] as const;
