/**
 * Structured logging interfaces (OBS-001; NFR-008, NFR-011, SR-005; observability §1).
 *
 * Records are JSON lines. `msg` is a constant template identifier (never interpolated data); variable content goes
 * into typed fields or `data`. Every serialized line passes the injected `transform` (redaction + PII hashing,
 * supplied by the app from `@autotest/policy`) before it reaches a sink; if the transform throws or breaks the JSON,
 * a fixed `log_redaction_failed` record is written instead (fail closed). Untrusted content (PR text, test names)
 * must be wrapped with {@link untrusted}: it is replaced by its length at `info` and above and truncated to 200
 * characters at `debug`. Sinks never write to stdout, which belongs to the MCP stdio transport.
 */
import type { ErrorCode } from '@autotest/contracts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly component: string;
  readonly sessionId?: string;
  readonly toolCallId?: string;
  readonly runId?: string;
  readonly planId?: string;
  readonly attemptNo?: number;
  readonly code?: ErrorCode;
  readonly durationMs?: number;
  readonly data?: Record<string, unknown>;
}

export type LogContext = Pick<LogRecord, 'sessionId' | 'toolCallId' | 'runId' | 'planId' | 'attemptNo'>;
export type LogFields = Partial<
  Pick<LogRecord, 'toolCallId' | 'runId' | 'planId' | 'attemptNo' | 'code' | 'durationMs' | 'data'>
>;

/** Receives complete, already-transformed JSON lines (with trailing newline). */
export interface LogSink {
  write(line: string): void;
}

/** A value from an untrusted source; see the module doc for how it is rendered. */
export class Untrusted {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}
export const untrusted = (text: string): Untrusted => new Untrusted(text);

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(context: LogContext): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  readonly component: string;
  readonly sinks: readonly LogSink[];
  readonly level?: LogLevel;
  /** Redaction and PII hashing over the serialized line. */
  readonly transform?: (line: string) => string;
  readonly context?: LogContext;
  readonly now?: () => Date;
}

/** Message templates: lowercase identifiers such as `tool.call.completed` or `metric`. */
export const LOG_MESSAGE = /^[a-z][a-z0-9_.:-]{0,79}$/;
const MAX_DEPTH = 4;
const MAX_ITEMS = 50;
const MAX_STRING = 2000;

/** Parses `AUTOTEST_LOG_LEVEL`; anything unknown falls back to `info`. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const v = value?.toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? 'info';
  const now = opts.now ?? (() => new Date());
  const transform = opts.transform ?? ((l: string) => l);
  const context = opts.context ?? {};

  const emit = (lvl: LogLevel, msg: string, fields: LogFields = {}) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const valid = LOG_MESSAGE.test(msg);
    const { data, ...rest } = fields;
    const record: LogRecord = {
      ts: now().toISOString(),
      level: lvl,
      msg: valid ? msg : 'invalid_log_message',
      component: opts.component,
      ...context,
      ...rest,
      ...(data || !valid
        ? {
            data: {
              ...(data ? (sanitize(data, lvl, 0) as Record<string, unknown>) : {}),
              ...(valid ? {} : { rejectedMessageLength: msg.length }),
            },
          }
        : {}),
    };
    let line: string;
    try {
      line = transform(JSON.stringify(record));
      JSON.parse(line);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: 'error', msg: 'log_redaction_failed', component: opts.component });
    }
    for (const s of opts.sinks) s.write(`${line}\n`);
  };

  return {
    level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (ctx) => createLogger({ ...opts, context: { ...context, ...ctx } }),
  };
}

function sanitize(value: unknown, level: LogLevel, depth: number): unknown {
  if (value instanceof Untrusted)
    return level === 'debug' ? value.text.slice(0, 200) : `[untrusted:${value.text.length} chars]`;
  if (typeof value === 'string')
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name };
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => sanitize(v, level, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS))
      out[k] = sanitize(v, level, depth + 1);
    return out;
  }
  return undefined;
}
