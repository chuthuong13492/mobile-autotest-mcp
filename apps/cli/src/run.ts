/** Argument parsing and dispatch for `autotest` (CLI-001). Exit codes: 0 success, 1 refused or failed, 2 usage. */
import { listApprovals } from './commands/approvals.ts';
import { approve } from './commands/approve.ts';
import { init } from './commands/init.ts';
import { revoke } from './commands/revoke.ts';
import { openCli, type CliEnv } from './context.ts';
import type { Io } from './io.ts';

export const USAGE = `usage:
  autotest init
  autotest approve <approvalRequestId>
  autotest revoke <approvalId>
  autotest approvals`;

const REQUEST_ID = /^apr_[0-9A-HJKMNP-TV-Z]{26}$/;
const APPROVAL_ID = /^appr_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function run(argv: readonly string[], io: Io, e: CliEnv): Promise<number> {
  const [cmd, arg, ...rest] = argv;
  if (cmd === 'init' && arg === undefined) return init(e, io);
  const valid =
    (cmd === 'approve' && arg !== undefined && REQUEST_ID.test(arg) && rest.length === 0) ||
    (cmd === 'revoke' && arg !== undefined && APPROVAL_ID.test(arg) && rest.length === 0) ||
    (cmd === 'approvals' && arg === undefined);
  if (!valid) {
    io.err(USAGE);
    return 2;
  }
  const ctx = openCli(e);
  try {
    if (cmd === 'approve') return await approve(arg!, ctx, io, e);
    if (cmd === 'revoke') return await revoke(arg!, ctx, io);
    return await listApprovals(ctx, io);
  } finally {
    ctx.close();
  }
}
