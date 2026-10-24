/** Argument parsing and dispatch for `autotest` (CLI-001). Exit codes: 0 success, 1 refused or failed, 2 usage. */
import { listApprovals } from './commands/approvals.ts';
import { approve } from './commands/approve.ts';
import { cleanup } from './commands/cleanup.ts';
import { doctor } from './commands/doctor.ts';
import { init } from './commands/init.ts';
import { addKnownFailure, listKnownFailures, parseAddFlags, removeKnownFailure } from './commands/known-failures.ts';
import { revoke } from './commands/revoke.ts';
import { parseSetupFlags, setup, uninstallClaude } from './commands/setup.ts';
import { openCli, type CliEnv } from './context.ts';
import type { Io } from './io.ts';

export const USAGE = `usage:
  autotest setup [--workspace <path>]... [--flutter <path>] [--enable-publication] [--yes] [--skip-claude]
  autotest uninstall-claude
  autotest init
  autotest doctor [--audit | --suggest-executables | --stats]
  autotest cleanup [--dry-run]
  autotest approve <approvalRequestId>
  autotest revoke <approvalId>
  autotest approvals [--all]
  autotest known-failures [list]
  autotest known-failures add --target <test path | TT-id> --name <pattern> --reason <text> --link <url>
                              --expires <YYYY-MM-DD> [--adapter <id>]
  autotest known-failures remove <KF-NNN>`;

const REQUEST_ID = /^apr_[0-9A-HJKMNP-TV-Z]{26}$/;
const APPROVAL_ID = /^appr_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function run(argv: readonly string[], io: Io, e: CliEnv): Promise<number> {
  const [cmd, arg, ...rest] = argv;
  if (cmd === 'init' && arg === undefined) return init(e, io);
  if (cmd === 'setup') {
    const f = parseSetupFlags(argv.slice(1));
    if (f) return setup(e, io, f);
  }
  if (cmd === 'uninstall-claude' && arg === undefined) return uninstallClaude(e, io);
  const flags = argv.slice(1);
  if (
    cmd === 'doctor' &&
    flags.length <= 1 &&
    flags.every((f) => f === '--audit' || f === '--suggest-executables' || f === '--stats')
  )
    return doctor(e, io, flags);
  const valid =
    (cmd === 'approve' && arg !== undefined && REQUEST_ID.test(arg) && rest.length === 0) ||
    (cmd === 'revoke' && arg !== undefined && APPROVAL_ID.test(arg) && rest.length === 0) ||
    (cmd === 'approvals' && (arg === undefined || (arg === '--all' && rest.length === 0))) ||
    (cmd === 'cleanup' && flags.every((f) => f === '--dry-run') && flags.length <= 1) ||
    (cmd === 'known-failures' && (arg === undefined || (arg === 'list' && rest.length === 0))) ||
    (cmd === 'known-failures' && arg === 'add' && parseAddFlags(rest) !== undefined) ||
    (cmd === 'known-failures' && arg === 'remove' && rest.length === 1 && /^KF-\d{3}$/.test(rest[0]!));
  if (!valid) {
    io.err(USAGE);
    return 2;
  }
  const ctx = openCli(e);
  try {
    if (cmd === 'approve') return await approve(arg!, ctx, io, e);
    if (cmd === 'revoke') return await revoke(arg!, ctx, io);
    if (cmd === 'cleanup') return await cleanup(ctx, io, flags);
    if (cmd === 'known-failures' && arg === 'add') return await addKnownFailure(ctx, io, parseAddFlags(rest)!);
    if (cmd === 'known-failures' && arg === 'remove') return await removeKnownFailure(ctx, io, rest[0]!);
    if (cmd === 'known-failures') return await listKnownFailures(ctx, io);
    return await listApprovals(ctx, io, arg === '--all');
  } finally {
    ctx.close();
  }
}
