/**
 * ExecPort: the only place that touches `child_process` (ADR-0014; boundary rule `only-exec-spawns`).
 *
 * Process listing uses `ps` with a fixed absolute path and argv (no shell). `lstart` has one-second resolution;
 * together with the pgid and the executable it identifies a process well enough to refuse to signal a reused PID
 * (ADR-0007 §3). The POSIX implementation covers macOS and Linux; Windows feasibility is preserved by keeping every
 * OS-specific call behind this interface.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

export interface ProcessRow {
  readonly pid: number;
  readonly pgid: number;
  /** `ps -o lstart` text, e.g. `Fri Oct 23 09:08:33 2026`. */
  readonly startTime: string;
}

export interface SpawnRequest {
  readonly file: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ExecPort {
  /** Spawns with `shell: false`, `detached: true` (own process group), stdin closed, stdout/stderr piped. */
  spawn(req: SpawnRequest): ChildProcess;
  /** Spawns a fully detached process (own group, no pipes, unref'd) with stdout/stderr appended to `logFile`. */
  spawnDetached(req: SpawnRequest & { readonly logFile: string }): { pid: number };
  /** The live (non-zombie) process with this pid, if any. */
  processInfo(pid: number): ProcessRow | undefined;
  /** Live (non-zombie) members of a process group. */
  groupMembers(pgid: number): ProcessRow[];
  /** Sends a signal to a pid, or to a group when `target` is negative. Returns false when nothing was there. */
  signal(target: number, signal: NodeJS.Signals): boolean;
  readonly capabilities: { readonly rlimits: boolean };
}

const PS = ['/bin/ps', '/usr/bin/ps'].find((p) => fs.existsSync(p));

function ps(args: readonly string[]): ProcessRow[] {
  if (!PS) throw new Error('ps not found');
  let out: string;
  try {
    out = execFileSync(PS, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // ps exits 1 when -p names no process.
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
  const rows: ProcessRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m || m[3]!.startsWith('Z')) continue;
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), startTime: m[4]! });
  }
  return rows;
}

const FIELDS = 'pid=,pgid=,stat=,lstart=';

export function nodeExecPort(): ExecPort {
  return {
    spawn: (req) =>
      spawn(req.file, [...req.argv], {
        cwd: req.cwd,
        env: { ...req.env },
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    spawnDetached: (req) => {
      const fd = fs.openSync(
        req.logFile,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const child = spawn(req.file, [...req.argv], {
          cwd: req.cwd,
          env: { ...req.env },
          shell: false,
          detached: true,
          stdio: ['ignore', fd, fd],
          windowsHide: true,
        });
        child.unref();
        if (child.pid === undefined) throw new Error('spawn failed');
        return { pid: child.pid };
      } finally {
        fs.closeSync(fd);
      }
    },
    processInfo: (pid) => ps(['-o', FIELDS, '-p', String(pid)])[0],
    groupMembers: (pgid) => ps(['-A', '-o', FIELDS]).filter((r) => r.pgid === pgid),
    signal: (target, sig) => {
      try {
        process.kill(target, sig);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw e;
      }
    },
    capabilities: { rlimits: false },
  };
}
