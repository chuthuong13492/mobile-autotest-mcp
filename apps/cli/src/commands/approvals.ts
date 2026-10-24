/** `autotest approvals [--all]` (CLI-001): open requests and recent (or all) approvals, after lazy expiry. */
import type { CliContext } from '../context.ts';
import type { Io } from '../io.ts';

export async function listApprovals(ctx: CliContext, io: Io, all = false): Promise<number> {
  const now = ctx.ports.clock.now();
  await ctx.ports.approvals.expireDue(now);
  const requests = await ctx.ports.approvals.listOpenRequests(now, 50);
  io.out(`Open requests (${requests.length}):`);
  for (const r of requests)
    io.out(
      `  ${r.id}  ${r.scope.kind}  needs ${r.requiredAssurance}  expires ${r.expiresAt}  ${r.display?.summary ?? ''}`.trimEnd(),
    );
  const approvals = await ctx.ports.approvals.listRecentApprovals(all ? 10_000 : 20);
  io.out(`${all ? 'All' : 'Recent'} approvals (${approvals.length}):`);
  for (const a of approvals)
    io.out(
      `  ${a.id}  ${a.state}  ${a.assuranceLevel}/${a.source}  uses ${a.uses}/${a.maxUses}  expires ${a.expiresAt}  ${a.scope.kind}`,
    );
  return 0;
}
