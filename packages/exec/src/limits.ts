/**
 * Output caps and timers (EXE-002; ADR-0014 §5). Output is written through a byte cap; past the cap a single
 * truncation marker is written and the rest of the stream is drained and discarded, so the child never blocks on a
 * full pipe.
 */
import fs from 'node:fs';
import type { Readable } from 'node:stream';

export const DEFAULT_OUTPUT_CAP = 50 * 1024 * 1024;

export const truncationMarker = (cap: number) => `\n[autotest: output truncated after ${cap} bytes]\n`;

export interface CappedOutput {
  /** Resolves when the stream has ended and the file is closed. */
  readonly done: Promise<{ bytesWritten: number; bytesSeen: number; truncated: boolean }>;
}

/** Pipes `stream` into `file` (mode 0600, created exclusively) up to `cap` bytes. */
export function captureCapped(stream: Readable, file: string, cap: number = DEFAULT_OUTPUT_CAP): CappedOutput {
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let written = 0;
  let seen = 0;
  let truncated = false;
  const done = new Promise<{ bytesWritten: number; bytesSeen: number; truncated: boolean }>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (truncated || closed) return;
      const room = cap - written;
      if (chunk.length <= room) {
        fs.writeSync(fd, chunk);
        written += chunk.length;
        return;
      }
      if (room > 0) fs.writeSync(fd, chunk.subarray(0, room));
      written = cap;
      fs.writeSync(fd, truncationMarker(cap));
      truncated = true;
    });
    // 'end' and 'close' both fire; closing twice could close an fd number already reused by another file.
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      resolve({ bytesWritten: written, bytesSeen: seen, truncated });
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', (e) => {
      finish();
      reject(e);
    });
  });
  return { done };
}

/** A cancellable one-shot timer. */
export function startTimer(ms: number, onExpire: () => void): { cancel(): void; readonly expired: () => boolean } {
  let fired = false;
  const t = setTimeout(() => {
    fired = true;
    onExpire();
  }, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t), expired: () => fired };
}
