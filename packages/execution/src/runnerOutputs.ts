/**
 * Reads one attempt's runner outputs for the adapter (ADR-0014): regular files directly under
 * `attempts/<n>/runner/`, and the attempt's captured standard output per spec (`attempts/<n>/stdout-<k>.log`, for
 * runners that report on stdout, such as `xcresulttool`, IOS-003), each capped, symlinks and other file types skipped.
 * Keys are run-dir-relative paths, which is what adapters address (`runnerOutput(n, file)`).
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
  const read = (relPath: string) => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(runDir, relPath), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, capBytes));
      const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
      files[relPath] = buf.subarray(0, n).toString('utf8');
    } catch {
      files[relPath] = undefined;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  for (const e of entries.filter((x) => x.isFile()).slice(0, MAX_FILES)) read(`${rel}/${e.name}`);
  const attempt = path.join(runDir, `attempts/${attemptNo}`);
  for (const e of fs.readdirSync(attempt, { withFileTypes: true }))
    if (e.isFile() && /^stdout-\d{1,3}\.log$/.test(e.name)) read(`attempts/${attemptNo}/${e.name}`);
  return files;
}
