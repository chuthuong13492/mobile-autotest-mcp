/**
 * Audit hash chain (SR-015; data model §AuditEvent): hash = sha256(prevHash ‖ JCS(event without hash)).
 * Pure functions shared by every AuditSink implementation; persistence lives in `@autotest/storage` (OBS-002).
 */
import type { AuditEvent } from '@autotest/contracts';
import { canonicalize, sha256Hex } from '@autotest/contracts';

/** Computes the chained hash for `event` (its own `hash` field is ignored). */
export function auditHash(event: Omit<AuditEvent, 'hash'> | AuditEvent): `sha256:${string}` {
  const { hash: _ignored, ...rest } = event as AuditEvent;
  void _ignored;
  return `sha256:${sha256Hex(`${rest.prevHash ?? ''}|${canonicalize(rest)}`)}`;
}

/** Returns the index of the first event whose link or hash is wrong, or -1 if the chain verifies. */
export function verifyAuditChain(events: readonly AuditEvent[]): number {
  let prev: string | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== i || e.prevHash !== prev || e.hash !== auditHash(e)) return i;
    prev = e.hash;
  }
  return -1;
}
