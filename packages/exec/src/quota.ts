/**
 * Per-run disk quota (EXE-004; FR-027, SR-010; T-07). `directoryUsage` sums regular-file sizes without following
 * symlinks; `watchQuota` checks periodically and calls `onBreach` once. The supervisor reacts by cancelling the run
 * with reason `resource_quota`. OS rlimits are reported through `ExecPort.capabilities` (not available for
 * shell-free spawns on macOS in v1.0; recorded as a limitation, never claimed).
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_RUN_DISK_QUOTA = 2 * 1024 * 1024 * 1024;

export interface Usage {
  readonly bytes: number;
  readonly files: number;
  /** True when the walk stopped early because `stopAboveBytes` was exceeded. */
  readonly partial: boolean;
}

/** Sums file sizes under `dir` (lstat; symlinks count as links, never followed). Stops early above `stopAboveBytes`. */
export function directoryUsage(dir: string, stopAboveBytes = Number.POSITIVE_INFINITY): Usage {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          bytes += fs.lstatSync(p).size;
          files++;
        } catch {
          // removed concurrently
        }
        if (bytes > stopAboveBytes) return { bytes, files, partial: true };
      }
    }
  }
  return { bytes, files, partial: false };
}

export interface QuotaWatch {
  stop(): void;
  /** Runs one check now (also used by tests). Returns true on breach. */
  check(): boolean;
}

export function watchQuota(
  dirs: readonly string[],
  quotaBytes: number,
  intervalMs: number,
  onBreach: (usage: number) => void,
): QuotaWatch {
  let breached = false;
  const check = () => {
    if (breached) return true;
    let total = 0;
    for (const d of dirs) total += directoryUsage(d, quotaBytes - total).bytes;
    if (total > quotaBytes) {
      breached = true;
      onBreach(total);
    }
    return breached;
  };
  const t = setInterval(check, intervalMs);
  t.unref?.();
  return { stop: () => clearInterval(t), check };
}
