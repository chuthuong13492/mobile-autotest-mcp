/** `autotest revoke <approvalId>` (CLI-001): revocation takes effect immediately, including for queued runs. */
import { PortError } from '@autotest/core';
import type { CliContext } from '../context.ts';
import type { Io } from '../io.ts';

export async function revoke(approvalId: string, ctx: CliContext, io: Io): Promise<number> {
  const now = ctx.ports.clock.now();
  try {
    const a = await ctx.ports.approvals.revoke(approvalId, ctx.osUser, now);
    await ctx.ports.audit.append({
      ts: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      actor: 'cli',
      kind: 'approval.revoked',
      subjectRefs: [a.id],
      data: { approvalId: a.id },
    });
    io.out(`Revoked ${a.id}.`);
    return 0;
  } catch (e) {
    if (e instanceof PortError) {
      io.err(e.code === 'not_found' ? `No approval ${approvalId}.` : `Cannot revoke ${approvalId}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
