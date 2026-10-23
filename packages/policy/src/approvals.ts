/**
 * Approval scopes, approval verification and pre-authorization (AUTH-002; FR-021, SR-007; ADR-0006 §1–§3; T-15).
 *
 * Pure: every input is passed in. An approval is usable only when it is `approved`, unexpired, has uses left, is
 * bound to exactly the expected scope digest, plan hash, environment and policy version, and its *effective*
 * assurance meets the policy minimum. Effective assurance is capped by the source: elicitation is AL1 (RL-031),
 * pre-authorization and CLI approvals are AL2, and AL3 is granted only when an {@link Al3Verifier} verifies the
 * record (signature or org review). The default verifier rejects everything until DISC-003/CI-003 land.
 */
import { z } from 'zod';
import {
  digest,
  Timestamp,
  type Approval,
  type ApprovalScope,
  type ApprovalScopeKind,
  type AssuranceLevel,
  type AuthorizationReason,
} from '@autotest/contracts';
import { parseYamlSafely } from './config.ts';
import {
  compareAssurance,
  minAssurance,
  PREAUTH_SATISFIES,
  type AssuranceOverrides,
  type AssuranceRequirement,
  type PolicyEnvironment,
} from './tiers.ts';

/** Digest of a scope: SHA-256 over the canonical `{ kind, params }`. */
export function scopeDigest(kind: ApprovalScopeKind, params: Record<string, unknown>): `sha256:${string}` {
  return digest({ kind, params });
}

const scope = (kind: ApprovalScopeKind, params: Record<string, unknown>): ApprovalScope => ({
  kind,
  digest: scopeDigest(kind, params),
  params,
});

/** `plan_execution`: plan hash + environment + digest of the sorted target set (ADR-0006 §3). */
export function planExecutionScope(p: {
  planHash: string;
  environment: string;
  targetIds: readonly string[];
}): ApprovalScope {
  return scope('plan_execution', {
    planHash: p.planHash,
    environment: p.environment,
    targetSetDigest: digest([...new Set(p.targetIds)].sort()),
  });
}

/** `device_action`: `(action, deviceId, hostId)` (mcp-tool-contracts TL-14). */
export function deviceActionScope(p: { action: string; deviceId: string; hostId: string }): ApprovalScope {
  return scope('device_action', { action: p.action, deviceId: p.deviceId, hostId: p.hostId });
}

/** `github_publish`: one scope per `(repo, pr, headSha, reportHash, mechanism)` (ADR-0006 §3). */
export function githubPublishScope(p: {
  host: string;
  owner: string;
  name: string;
  pr: number;
  headSha: string;
  reportHash: string;
  mechanism: string;
}): ApprovalScope {
  return scope('github_publish', {
    host: p.host,
    owner: p.owner,
    name: p.name,
    pr: p.pr,
    headSha: p.headSha,
    reportHash: p.reportHash,
    mechanism: p.mechanism,
  });
}

/** `coverage_exception`: bound to the plan hash and the exception's content (excluding its approval link). */
export function coverageExceptionScope(p: {
  planHash: string;
  exception: { id: string; approvalId?: string | undefined } & Record<string, unknown>;
}): ApprovalScope {
  const content = Object.fromEntries(Object.entries(p.exception).filter(([k]) => k !== 'approvalId'));
  return scope('coverage_exception', {
    planHash: p.planHash,
    exceptionId: p.exception.id,
    contentDigest: digest(content),
  });
}

/** Verifies AL3 evidence: a user-presence signature (DISC-003) or a verified org review (CI-003). */
export interface Al3Verifier {
  verify(approval: Approval): boolean;
}

/** Fail-closed default until an AL3 mechanism is chosen (OQ-13): AL3 claims are treated as AL2. */
export const NO_AL3: Al3Verifier = { verify: () => false };

export type UnusableReason =
  | 'not_approved'
  | 'expired'
  | 'revoked'
  | 'superseded'
  | 'exhausted'
  | 'scope_mismatch'
  | 'scope_digest_invalid'
  | 'stale_plan_hash'
  | 'stale_environment'
  | 'stale_policy_version'
  | 'source_not_allowed'
  | 'assurance_insufficient'
  | 'not_allowed_in_environment';

export interface ApprovalExpectation {
  /** The scope as computed now from current state; the approval must carry the same digest. */
  readonly scope: ApprovalScope;
  readonly planHash?: string;
  /** e.g. `local:<hostId>` or `ci:<provider>:<owner>/<repo>`. */
  readonly environment: string;
  readonly policyVersion: string;
}

export interface VerifyContext {
  readonly now: Date;
  readonly environmentKind: PolicyEnvironment;
  readonly overrides: AssuranceOverrides;
  readonly al3: Al3Verifier;
}

export interface ApprovalVerification {
  readonly usable: boolean;
  readonly reasons: readonly UnusableReason[];
  readonly effectiveAssurance: AssuranceLevel;
  readonly required: AssuranceRequirement;
}

/** The assurance an approval actually provides, capped by what its source can prove. */
export function effectiveAssurance(a: Approval, al3: Al3Verifier): AssuranceLevel {
  const cap: AssuranceLevel =
    a.source === 'elicitation' ? 'AL1' : a.assuranceLevel === 'AL3' && al3.verify(a) ? 'AL3' : 'AL2';
  return compareAssurance(a.assuranceLevel, cap) <= 0 ? a.assuranceLevel : cap;
}

/** Checks one approval against the expectation. Collects every reason rather than stopping at the first. */
export function verifyApproval(a: Approval, expected: ApprovalExpectation, ctx: VerifyContext): ApprovalVerification {
  const reasons: UnusableReason[] = [];
  const state = a.state;
  if (state === 'revoked') reasons.push('revoked');
  else if (state === 'superseded') reasons.push('superseded');
  else if (state === 'expired') reasons.push('expired');
  else if (state === 'consumed') reasons.push('exhausted');
  else if (state !== 'approved') reasons.push('not_approved');
  if (state === 'approved' && ctx.now.getTime() >= Date.parse(a.expiresAt)) reasons.push('expired');
  if (state === 'approved' && a.uses >= a.maxUses) reasons.push('exhausted');

  if (a.scope.kind !== expected.scope.kind || a.scope.digest !== expected.scope.digest) reasons.push('scope_mismatch');
  if (scopeDigest(a.scope.kind, a.scope.params) !== a.scope.digest) reasons.push('scope_digest_invalid');
  if ((expected.planHash ?? null) !== (a.planHash ?? null)) reasons.push('stale_plan_hash');
  if (a.environment !== expected.environment) reasons.push('stale_environment');
  if (a.policyVersion !== expected.policyVersion) reasons.push('stale_policy_version');

  const { required, preauthSatisfies } = minAssurance(expected.scope.kind, ctx.environmentKind, ctx.overrides);
  const effective = effectiveAssurance(a, ctx.al3);
  if (a.source === 'preauth' && !PREAUTH_SATISFIES.has(a.scope.kind)) reasons.push('source_not_allowed');
  if (required === 'not_allowed') reasons.push('not_allowed_in_environment');
  else if (
    required !== 'none' &&
    !(a.source === 'preauth' && preauthSatisfies) &&
    compareAssurance(effective, required) < 0
  )
    reasons.push('assurance_insufficient');

  return { usable: reasons.length === 0, reasons, effectiveAssurance: effective, required };
}

/** Maps unusable reasons to the authorization reason codes of ADR-0006 §4. */
export function toAuthorizationReasons(reasons: readonly UnusableReason[]): AuthorizationReason[] {
  const map: Record<UnusableReason, AuthorizationReason> = {
    not_approved: 'approval_required',
    expired: 'approval_expired',
    revoked: 'approval_revoked',
    superseded: 'approval_stale',
    exhausted: 'approval_exhausted',
    scope_mismatch: 'approval_stale',
    scope_digest_invalid: 'approval_stale',
    stale_plan_hash: 'approval_stale',
    stale_environment: 'approval_stale',
    stale_policy_version: 'approval_stale',
    source_not_allowed: 'assurance_insufficient',
    assurance_insufficient: 'assurance_insufficient',
    not_allowed_in_environment: 'approval_required',
  };
  return [...new Set(reasons.map((r) => map[r]))];
}

export interface ApprovalSelection {
  /** The first usable approval (oldest first), if any. */
  readonly approval?: Approval;
  /** When none is usable: the reasons of the closest candidate, or `approval_required` when there are none. */
  readonly reasons: readonly AuthorizationReason[];
}

/** Picks a usable approval among candidates; reports why none qualifies otherwise. */
export function selectApproval(
  candidates: readonly Approval[],
  expected: ApprovalExpectation,
  ctx: VerifyContext,
): ApprovalSelection {
  const sorted = [...candidates].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  );
  let best: ApprovalVerification | undefined;
  for (const a of sorted) {
    const v = verifyApproval(a, expected, ctx);
    if (v.usable) return { approval: a, reasons: [] };
    if (!best || v.reasons.length < best.reasons.length) best = v;
  }
  return { reasons: best ? toAuthorizationReasons(best.reasons) : ['approval_required'] };
}

// ---------------------------------------------------------------- pre-authorization file
const PreauthEntry = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  scope: z.literal('github_publish'),
  environment: z.string().regex(/^(local:[A-Za-z0-9._-]+|ci:[a-z0-9-]+:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/),
  match: z.strictObject({
    host: z.string().regex(/^[a-z0-9.-]{1,253}$/),
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    mechanisms: z
      .array(z.enum(['comment', 'check_run', 'commit_status']))
      .min(1)
      .max(3),
  }),
  expiresAt: Timestamp,
});
export type PreauthEntry = z.infer<typeof PreauthEntry>;

const PreauthFile = z.strictObject({ version: z.literal(1), entries: z.array(PreauthEntry).max(100) });

export interface PreauthParseResult {
  readonly entries: readonly PreauthEntry[];
  readonly errors: readonly string[];
  /** Digest of the canonical file content, recorded on approvals minted from it. */
  readonly fileDigest?: `sha256:${string}`;
}

/**
 * Parses the user-owned pre-authorization file (`~/.autotest/preauth.yaml`, never repository content). Only
 * `github_publish` can be pre-authorized; any invalid file pre-authorizes nothing.
 */
export function parsePreauthFile(text: string | undefined): PreauthParseResult {
  if (text === undefined) return { entries: [], errors: [] };
  let raw: unknown;
  try {
    raw = parseYamlSafely(text, 64 * 1024);
  } catch (e) {
    return { entries: [], errors: [(e as Error).message] };
  }
  const parsed = PreauthFile.safeParse(raw);
  if (!parsed.success)
    return { entries: [], errors: parsed.error.issues.map((i) => `/${i.path.join('/')}: ${i.message}`.slice(0, 200)) };
  const ids = new Set<string>();
  for (const e of parsed.data.entries) {
    if (ids.has(e.id)) return { entries: [], errors: [`duplicate entry id ${e.id}`] };
    ids.add(e.id);
  }
  return { entries: parsed.data.entries, errors: [], fileDigest: digest(parsed.data) };
}

/** Finds an unexpired entry that covers this publication exactly (host, owner, name, mechanism, environment). */
export function matchPreauth(
  entries: readonly PreauthEntry[],
  target: { host: string; owner: string; name: string; mechanism: string; environment: string },
  now: Date,
): PreauthEntry | undefined {
  return entries.find(
    (e) =>
      now.getTime() < Date.parse(e.expiresAt) &&
      e.environment === target.environment &&
      e.match.host === target.host &&
      e.match.owner === target.owner &&
      e.match.name === target.name &&
      (e.match.mechanisms as readonly string[]).includes(target.mechanism),
  );
}
