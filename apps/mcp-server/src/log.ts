/**
 * Server log sinks and redaction wiring (OBS-001; observability §1).
 *
 * - `stderrSink` writes JSON lines to stderr; stdout is reserved for the MCP stdio transport.
 * - `fileSink` appends to `~/.autotest/logs/server-YYYY-MM-DD.ndjson` (0600, directory 0700), size-capped per day.
 * - `serverLogTransform` applies the `@autotest/policy` redactor (known secret values, credential patterns,
 *   high-entropy tokens) and hashes e-mail addresses and phone numbers, so every line is redacted before any sink.
 * - `guardConsole` routes `console.*` from dependencies to stderr through the same transform, so a library can
 *   never corrupt the protocol stream or bypass redaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { createIdGenerator, createLogger, parseLogLevel, type Logger, type LogSink } from '@autotest/core';
import { createRedactor, hashPiiInText } from '@autotest/policy';

export function stderrSink(stream: { write(s: string): unknown } = process.stderr): LogSink {
  return { write: (line) => void stream.write(line) };
}

/**
 * Daily file sink; once `maxBytesPerDay` is reached it writes one `log_file_capped` line and drops the rest.
 * Best-effort (OPS-006): a failing write (disk full, permissions) drops that line and never reaches the caller, so
 * logging can never break a tool call. The stderr sink still carries every line.
 */
export function fileSink(dir: string, maxBytesPerDay = 50 * 1024 * 1024, now: () => Date = () => new Date()): LogSink {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // the first write fails and is dropped as well
  }
  const capped = new Set<string>();
  const append = (line: string) => {
    const day = now().toISOString().slice(0, 10);
    const file = path.join(dir, `server-${day}.ndjson`);
    if (capped.has(day)) return;
    let size: number;
    try {
      size = fs.lstatSync(file).size;
    } catch {
      size = 0;
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      if (size + Buffer.byteLength(line) > maxBytesPerDay) {
        capped.add(day);
        fs.writeSync(
          fd,
          `${JSON.stringify({ ts: now().toISOString(), level: 'warn', msg: 'log_file_capped', component: 'log' })}\n`,
        );
      } else fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  };
  return {
    write(line) {
      try {
        append(line);
      } catch {
        // dropped (see above)
      }
    },
  };
}

export interface TransformOptions {
  /** Secret values known to this process (resolved credentials); redacted wherever they appear. */
  readonly knownValues?: readonly string[];
  /** Per-data-root salt for PII hashes. */
  readonly piiSalt: string;
}

/** Redaction + PII hashing over one serialized line. Throws on redaction failure (the logger then fails closed). */
export function serverLogTransform(opts: TransformOptions): (line: string) => string {
  const redactor = createRedactor({ knownValues: opts.knownValues ?? [] });
  return (line) => hashPiiInText(redactor.redact(line).text, opts.piiSalt);
}

export interface ServerLoggerOptions extends TransformOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logDir?: string;
  readonly stderr?: { write(s: string): unknown };
}

/** The server's root logger: a fresh `sessionId`, level from `AUTOTEST_LOG_LEVEL`, stderr plus optional file sink. */
export function createServerLogger(opts: ServerLoggerOptions): Logger {
  const sinks: LogSink[] = [stderrSink(opts.stderr)];
  if (opts.logDir) sinks.push(fileSink(opts.logDir));
  return createLogger({
    component: 'mcp-server',
    sinks,
    level: parseLogLevel((opts.env ?? process.env)['AUTOTEST_LOG_LEVEL']),
    transform: serverLogTransform(opts),
    context: { sessionId: createIdGenerator().newId('ses') },
  });
}

/** Routes console output to stderr through `transform`. Returns a function that restores the originals. */
export function guardConsole(
  transform: (line: string) => string,
  stream: { write(s: string): unknown } = process.stderr,
): () => void {
  const methods = ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const;
  const original = Object.fromEntries(methods.map((m) => [m, console[m]])) as Record<
    (typeof methods)[number],
    (...a: unknown[]) => void
  >;
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      let text: string;
      try {
        text = transform(format(...args));
      } catch {
        text = '[console output dropped: redaction failed]';
      }
      stream.write(`${text}\n`);
    };
  }
  return () => {
    for (const m of methods) console[m] = original[m];
  };
}
