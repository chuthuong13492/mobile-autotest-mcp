/**
 * Audit event data rules (OBS-002; SR-015; observability §5 "Privacy"). Audit `data` carries IDs, digests, enum
 * values and counts — never raw content. Every kind has required keys; every string is short and single-line;
 * nesting and list sizes are bounded. Sinks reject events that break these rules (fail closed).
 */
import type { AuditEventKind } from '@autotest/contracts';

/** Required `data` keys per mandatory event kind. */
export const AUDIT_REQUIRED_DATA: Readonly<Record<AuditEventKind, readonly string[]>> = {
  'tool.call': ['tool', 'toolCallId'],
  'tool.result': ['tool', 'toolCallId', 'result'],
  'policy.decision': ['decision', 'reasons'],
  'authorization.decision': ['phase', 'result', 'reasons', 'inputsDigest'],
  'coverage.decision': ['decision', 'planHash', 'gatePolicyVersion'],
  'approval.requested': ['scopeKind', 'scopeDigest', 'requiredAssurance'],
  'approval.created': ['approvalId', 'source', 'assurance', 'scopeDigest'],
  'approval.consumed': ['approvalId', 'uses'],
  'approval.revoked': ['approvalId'],
  'approval.expired': ['approvalId'],
  'approval.superseded': ['approvalId', 'planHash'],
  'plan.versioned': ['planId', 'version', 'planHash'],
  'run.created': ['runId', 'planHash', 'authorizationId'],
  'run.transition': ['runId', 'from', 'to'],
  'run.cancel_requested': ['runId', 'reason'],
  'process.signal': ['pid', 'pgid', 'startTime', 'signal'],
  'artifact.ingested': ['artifactId', 'kind', 'sha256'],
  'artifact.quarantined': ['artifactId', 'reason'],
  'device.action': ['action', 'deviceId', 'tier'],
  'github.write': ['mechanism', 'remoteId'],
  'config.loaded': ['policyVersion', 'gatePolicyVersion', 'riskPolicyVersion'],
  'reconciliation.action': ['action'],
  'report.generated': ['reportId', 'reportHash'],
  'known_failure.added': ['knownFailureId', 'targetId', 'expiresAt'],
  'known_failure.removed': ['knownFailureId'],
};

const KEY = /^[a-z][A-Za-z0-9_]{0,40}$/;
const MAX_STRING = 256;

/** Returns the problems with an event's data (empty when acceptable). Problem texts name keys, never values. */
export function checkAuditData(kind: AuditEventKind, data: Readonly<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  for (const k of AUDIT_REQUIRED_DATA[kind] ?? []) if (!(k in data)) problems.push(`missing ${k}`);
  const walk = (v: unknown, at: string, depth: number) => {
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
    if (typeof v === 'string') {
      if (v.length > MAX_STRING || [...v].some((c) => c.charCodeAt(0) < 0x20))
        problems.push(`${at}: string too long or multi-line`);
      return;
    }
    if (depth >= 3) {
      problems.push(`${at}: nested too deeply`);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > 50) problems.push(`${at}: too many items`);
      v.slice(0, 50).forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1));
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (!KEY.test(k)) problems.push(`${at}: invalid key`);
        else walk(x, `${at}.${k}`, depth + 1);
      }
      return;
    }
    problems.push(`${at}: unsupported value`);
  };
  walk(data, 'data', 0);
  return problems;
}

/** Raised by audit sinks for data that breaks the rules above. */
export class AuditDataError extends Error {
  override readonly name = 'AuditDataError';
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`audit data rejected: ${problems.slice(0, 5).join('; ')}`);
    this.problems = problems;
  }
}

/** Throws {@link AuditDataError} unless the data is acceptable. */
export function assertAuditData(kind: AuditEventKind, data: Readonly<Record<string, unknown>>): void {
  const p = checkAuditData(kind, data);
  if (p.length) throw new AuditDataError(p);
}
