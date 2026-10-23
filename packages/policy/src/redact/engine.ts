/**
 * Redaction engine (POL-005; SR-005, NFR-011; T-05).
 *
 * Sources, in order: exact known secret values for the run (longest first, plus their URL-encoded and base64
 * forms), private-key blocks, credential patterns, then high-entropy tokens. Text is processed line by line so the
 * same code serves whole texts and streams: a secret split across chunk boundaries is matched once its line is
 * complete. Any exception inside a rule is raised as {@link RedactionError}; callers quarantine the artifact and add
 * the `redaction_failed` limitation (fail closed).
 */
import {
  DEFAULT_ENTROPY_THRESHOLD,
  ENTROPY_CANDIDATE,
  PATTERN_RULES,
  PRIVATE_KEY_BEGIN,
  PRIVATE_KEY_END,
  RULESET_ID,
  SAFE_FORMATS,
  type FindingClass,
  type PatternRule,
} from './ruleset.ts';

export class RedactionError extends Error {
  override readonly name = 'RedactionError';
  readonly rule: string;
  constructor(rule: string, cause: unknown) {
    super(`redaction rule ${rule} failed`, { cause });
    this.rule = rule;
  }
}

export type Findings = Partial<Record<FindingClass, number>>;

export interface RedactorOptions {
  readonly knownValues?: readonly string[];
  readonly entropyThreshold?: number;
  /** Overrides the pattern rules (test seam and future rulesets). */
  readonly rules?: readonly PatternRule[];
}

export interface RedactionOutput {
  readonly text: string;
  readonly findings: Findings;
}

export interface StreamRedactor {
  /** Returns the redacted text of every line completed by this chunk. */
  push(chunk: string): string;
  /** Flushes the final partial line. */
  end(): string;
  readonly findings: Findings;
}

export interface Redactor {
  readonly rulesetId: typeof RULESET_ID;
  /** Known values shorter than {@link MIN_KNOWN_VALUE} are not matched; callers add a limitation when this is > 0. */
  readonly weakKnownValues: number;
  redact(text: string): RedactionOutput;
  stream(): StreamRedactor;
}

export const MIN_KNOWN_VALUE = 4;
/** Lines longer than this are split (at whitespace when possible) so memory stays bounded. */
export const MAX_LINE = 1024 * 1024;

const marker = (c: FindingClass) => `[REDACTED:${c}]`;

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const rules = options.rules ?? PATTERN_RULES;
  const threshold = options.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD;
  const known = new Set<string>();
  let weak = 0;
  for (const v of options.knownValues ?? []) {
    for (const line of v.split(/\r?\n/)) {
      if (line.length < MIN_KNOWN_VALUE) {
        if (line.length > 0) weak++;
        continue;
      }
      known.add(line);
      known.add(encodeURIComponent(line));
      known.add(Buffer.from(line, 'utf8').toString('base64').replace(/=+$/, ''));
    }
  }
  const knownRe = known.size
    ? new RegExp(
        [...known]
          .sort((a, b) => b.length - a.length)
          .map(escapeRe)
          .join('|'),
        'g',
      )
    : undefined;

  const redactLine = (line: string, findings: Findings): string => {
    let out = line;
    if (knownRe)
      out = apply('known_value', out, findings, () => out.replace(knownRe, () => count(findings, 'known_value')));
    for (const rule of rules) {
      out = apply(rule.id, out, findings, () =>
        out.replace(rule.pattern, (...args: unknown[]) => {
          const groups = args.at(-1) as Record<string, string | undefined> | undefined;
          return `${groups?.['keep'] ?? ''}${count(findings, rule.id)}${groups?.['tail'] ?? ''}`;
        }),
      );
    }
    out = apply('high_entropy', out, findings, () =>
      out.replace(ENTROPY_CANDIDATE, (m) =>
        isSafeFormat(m) || !looksSecret(m, threshold) ? m : count(findings, 'high_entropy'),
      ),
    );
    return out;
  };

  const stream = (): StreamRedactor => {
    const findings: Findings = {};
    let buf = '';
    let inKey = false;

    /** Redacts one complete line (without its terminator); returns null for lines inside a private key block. */
    const processLine = (line: string): string | null => {
      if (inKey) {
        const end = PRIVATE_KEY_END.exec(line);
        if (!end) return null;
        inKey = false;
        const rest = line.slice(end.index + end[0].length);
        return rest ? redactLine(rest, findings) : null;
      }
      const begin = PRIVATE_KEY_BEGIN.exec(line);
      if (begin) {
        const before = redactLine(line.slice(0, begin.index), findings);
        count(findings, 'private_key');
        const after = line.slice(begin.index + begin[0].length);
        const end = PRIVATE_KEY_END.exec(after);
        if (end)
          return `${before}${marker('private_key')}${redactLine(after.slice(end.index + end[0].length), findings)}`;
        inKey = true;
        return `${before}${marker('private_key')}`;
      }
      return redactLine(line, findings);
    };

    const drain = (final: boolean): string => {
      let out = '';
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          const raw = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const cr = raw.endsWith('\r');
          const r = processLine(cr ? raw.slice(0, -1) : raw);
          if (r !== null) out += `${r}${cr ? '\r' : ''}\n`;
          continue;
        }
        if (buf.length > MAX_LINE) {
          const window = buf.slice(MAX_LINE - 4096, MAX_LINE);
          const ws = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
          const cut = ws >= 0 ? MAX_LINE - 4096 + ws + 1 : MAX_LINE;
          const r = processLine(buf.slice(0, cut));
          buf = buf.slice(cut);
          if (r !== null) out += r;
          continue;
        }
        if (final && buf.length > 0) {
          const r = processLine(buf);
          buf = '';
          if (r !== null) out += r;
        }
        return out;
      }
    };

    return {
      push: (chunk) => {
        buf += chunk;
        return drain(false);
      },
      end: () => drain(true),
      findings,
    };
  };

  return {
    rulesetId: RULESET_ID,
    weakKnownValues: weak,
    redact: (text) => {
      const s = stream();
      const out = s.push(text) + s.end();
      return { text: out, findings: s.findings };
    },
    stream,
  };
}

function apply(rule: string, input: string, _findings: Findings, f: () => string): string {
  try {
    return f();
  } catch (e) {
    throw new RedactionError(rule, e);
  }
}

function count(findings: Findings, c: FindingClass): string {
  findings[c] = (findings[c] ?? 0) + 1;
  return marker(c);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSafeFormat(token: string): boolean {
  return SAFE_FORMATS.some((re) => re.test(token));
}

/** Shannon entropy per character ≥ threshold, and at least three of lower/upper/digit. */
export function looksSecret(token: string, threshold = DEFAULT_ENTROPY_THRESHOLD): boolean {
  const classes = Number(/[a-z]/.test(token)) + Number(/[A-Z]/.test(token)) + Number(/\d/.test(token));
  if (classes < 3) return false;
  return shannonEntropy(token) >= threshold;
}

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
