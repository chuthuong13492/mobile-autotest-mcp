/**
 * Detached Node entrypoint launcher (EXE-003 support; ADR-0007 §2). Used only to start the run supervisor: the
 * executable is the running Node binary, the entry must be an absolute `.ts`/`.js` file, and every argument must be
 * a plain token (the supervisor's argv carries only the run id and the data-root path). No shell, no inherited
 * environment beyond a minimal PATH/HOME/locale, own process group, output appended to a log file.
 */
import path from 'node:path';
import type { ProcessIdentity } from '@autotest/contracts';
import { identify } from './identity.ts';
import { nodeExecPort, type ExecPort } from './port.ts';

const TOKEN = /^[A-Za-z0-9_.:/@-]{1,1024}$/;

export class LaunchError extends Error {
  override readonly name = 'LaunchError';
}

export interface LaunchRequest {
  readonly entry: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly logFile: string;
  /** Extra environment: allowlisted variables the supervisor passes on to children (loader-hijacking names refused). */
  readonly env?: Readonly<Record<string, string>>;
  readonly port?: ExecPort;
}

export function launchDetachedNode(req: LaunchRequest): ProcessIdentity {
  if (!path.isAbsolute(req.entry) || !/\.(ts|js|mjs)$/.test(req.entry) || !TOKEN.test(req.entry))
    throw new LaunchError('entry must be an absolute .ts/.js path');
  for (const a of req.args)
    if (!TOKEN.test(a) || a.startsWith('-')) throw new LaunchError('arguments must be plain tokens');
  const extra = req.env ?? {};
  for (const [k, v] of Object.entries(extra)) {
    if (
      !/^[A-Z_][A-Z0-9_]{0,63}$/.test(k) ||
      /^(LD_|DYLD_)|^NODE_OPTIONS$/.test(k) ||
      v.length > 8192 ||
      /[\0\r\n]/.test(v)
    )
      throw new LaunchError('invalid environment entry');
  }
  const port = req.port ?? nodeExecPort();
  const env = { PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/', LANG: 'en_US.UTF-8', ...extra };
  const { pid } = port.spawnDetached({
    file: process.execPath,
    argv: [req.entry, ...req.args],
    cwd: req.cwd,
    env,
    logFile: req.logFile,
  });
  return (
    identify(port, pid, process.execPath) ?? { pid, pgid: pid, startTime: 'unknown', executable: process.execPath }
  );
}
