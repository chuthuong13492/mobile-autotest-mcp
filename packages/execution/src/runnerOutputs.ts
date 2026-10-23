/**
 * Reads one attempt's runner outputs for the adapter (ADR-0014): regular files directly under
 * `attempts/<n>/runner/`, each capped, symlinks and other file types skipped. Keys are run-dir-relative paths,
 * which is what adapters address (`runnerOutput(n, file)`).
 */
import fs from 'node:fs';
import path from 'node:path';

export const RUNNER_FILE_CAP_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 200;

export function readRunnerOutputs(
  runDir: string,
  attemptNo: number,
  capBytes = RUNNER_FILE_CAP_BYTES,
): Record<string, string | undefined> {
  const rel = `attempts/${attemptNo}/runner`;
  const dir = path.join(runDir, rel);
  const files: Record<string, string | undefined> = {};
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries.filter((x) => x.isFile()).slice(0, MAX_FILES)) {
    const file = path.join(dir, e.name);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, capBytes));
      const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
      files[`${rel}/${e.name}`] = buf.subarray(0, n).toString('utf8');
    } catch {
      files[`${rel}/${e.name}`] = undefined;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return files;
}
