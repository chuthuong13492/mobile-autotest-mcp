/**
 * JUnit XML writer (ADP-002; FR-039; RL-016). Produces the widely consumed `testsuites/testsuite/testcase` shape
 * (Ant/Jenkins JUnit schema). All text and attribute values are escaped; characters that XML 1.0 cannot carry at all
 * (C0 controls other than tab/newline/CR, lone surrogates, U+FFFE/U+FFFF) are replaced by a visible `\xNN` escape,
 * so test names from repositories cannot inject markup or produce an unparsable file.
 */
import type { NormalizedResult } from './types.ts';

export interface JUnitCase extends Pick<
  NormalizedResult,
  'name' | 'outcome' | 'failureKind' | 'blockedReason' | 'durationMs' | 'messageExcerpt'
> {
  readonly classname: string;
}

export interface JUnitSuite {
  readonly name: string;
  readonly cases: readonly JUnitCase[];
}

export interface JUnitDocument {
  readonly name: string;
  readonly suites: readonly JUnitSuite[];
  /** ISO timestamp written on each suite (optional; omit for byte-stable output). */
  readonly timestamp?: string;
}

/** Replaces characters XML 1.0 cannot represent, then escapes markup. */
export function xmlEscape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      out += text[i]! + text[i + 1]!;
      i++;
      continue;
    }
    if (
      (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) ||
      (c >= 0xd800 && c <= 0xdfff) ||
      c === 0xfffe ||
      c === 0xffff
    ) {
      out += `\\x${c.toString(16).padStart(2, '0')}`;
      continue;
    }
    const ch = text[i]!;
    out +=
      ch === '&'
        ? '&amp;'
        : ch === '<'
          ? '&lt;'
          : ch === '>'
            ? '&gt;'
            : ch === '"'
              ? '&quot;'
              : ch === "'"
                ? '&apos;'
                : ch;
  }
  return out;
}

const attr = (name: string, value: string | number) => ` ${name}="${xmlEscape(String(value))}"`;
const secs = (ms: number | undefined) => ((ms ?? 0) / 1000).toFixed(3);

function caseBody(c: JUnitCase): string {
  const msg = c.messageExcerpt ?? '';
  switch (c.outcome) {
    case 'passed':
      return '';
    case 'failed': {
      const tag = c.failureKind === 'assertion' || c.failureKind === undefined ? 'failure' : 'error';
      return `<${tag}${attr('type', c.failureKind ?? 'assertion')}${attr('message', msg.split('\n')[0]!.slice(0, 500))}>${xmlEscape(msg)}</${tag}>`;
    }
    case 'timed_out':
    case 'infra_error':
      return `<error${attr('type', c.outcome)}${attr('message', (msg || c.outcome).split('\n')[0]!.slice(0, 500))}>${xmlEscape(msg)}</error>`;
    default:
      // skipped, blocked, cancelled, not_run: not executed.
      return `<skipped${attr('message', c.blockedReason ? `${c.outcome}: ${c.blockedReason}` : c.outcome)}/>`;
  }
}

export function toJUnit(doc: JUnitDocument): string {
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  let totalMs = 0;
  const suites = doc.suites.map((s) => {
    const f = s.cases.filter(
      (c) => c.outcome === 'failed' && (c.failureKind === 'assertion' || c.failureKind === undefined),
    ).length;
    const e = s.cases.filter(
      (c) =>
        (c.outcome === 'failed' && c.failureKind !== 'assertion' && c.failureKind !== undefined) ||
        c.outcome === 'timed_out' ||
        c.outcome === 'infra_error',
    ).length;
    const sk = s.cases.filter((c) => ['skipped', 'blocked', 'cancelled', 'not_run'].includes(c.outcome)).length;
    const ms = s.cases.reduce((a, c) => a + (c.durationMs ?? 0), 0);
    tests += s.cases.length;
    failures += f;
    errors += e;
    skipped += sk;
    totalMs += ms;
    const cases = s.cases.map((c) => {
      const body = caseBody(c);
      const open = `<testcase${attr('name', c.name)}${attr('classname', c.classname)}${attr('time', secs(c.durationMs))}`;
      return body ? `    ${open}>${body}</testcase>` : `    ${open}/>`;
    });
    return [
      `  <testsuite${attr('name', s.name)}${attr('tests', s.cases.length)}${attr('failures', f)}${attr('errors', e)}${attr('skipped', sk)}${attr('time', secs(ms))}${doc.timestamp ? attr('timestamp', doc.timestamp) : ''}>`,
      ...cases,
      '  </testsuite>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites${attr('name', doc.name)}${attr('tests', tests)}${attr('failures', failures)}${attr('errors', errors)}${attr('skipped', skipped)}${attr('time', secs(totalMs))}>`,
    ...suites,
    '</testsuites>',
    '',
  ].join('\n');
}
