import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toJUnit, xmlEscape, type JUnitDocument } from '@autotest/adapter-sdk';

/**
 * Strict XML 1.0 well-formedness check for the subset the writer emits (elements, double-quoted attributes, text,
 * the five predefined entities), followed by the structural rules of the Ant/Jenkins JUnit XSD. Returns the tree.
 */
interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
  text: string;
}
/** True when `s` contains a character XML 1.0 cannot carry (C0 controls except tab/LF/CR, U+FFFE/F, lone surrogates). */
function hasBadChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (
      (c >= 0xdc00 && c <= 0xdfff) ||
      (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) ||
      c === 0xfffe ||
      c === 0xffff
    )
      return true;
  }
  return false;
}
const unescape = (s: string) => {
  if (/&(?!(amp|lt|gt|quot|apos);)/.test(s)) throw new Error('bad entity');
  return s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]!,
  );
};
function parseXml(xml: string): El {
  if (hasBadChar(xml)) throw new Error('character not allowed in XML 1.0');
  let i = 0;
  const prolog = '<?xml version="1.0" encoding="UTF-8"?>';
  if (!xml.startsWith(prolog)) throw new Error('missing prolog');
  i = prolog.length;
  const ws = () => {
    while (/\s/.test(xml[i] ?? '')) i++;
  };
  const element = (): El => {
    const m = /^<([A-Za-z_][\w.-]*)/.exec(xml.slice(i));
    if (!m) throw new Error(`expected element at ${i}`);
    i += m[0].length;
    const el: El = { name: m[1]!, attrs: {}, children: [], text: '' };
    for (;;) {
      ws();
      if (xml.startsWith('/>', i)) {
        i += 2;
        return el;
      }
      if (xml[i] === '>') {
        i++;
        break;
      }
      const a = /^([A-Za-z_][\w.-]*)="([^"<]*)"/.exec(xml.slice(i));
      if (!a) throw new Error(`bad attribute at ${i}`);
      if (a[1]! in el.attrs) throw new Error('duplicate attribute');
      el.attrs[a[1]!] = unescape(a[2]!);
      i += a[0].length;
    }
    for (;;) {
      const lt = xml.indexOf('<', i);
      if (lt < 0) throw new Error('unclosed element');
      el.text += unescape(xml.slice(i, lt));
      i = lt;
      if (xml.startsWith(`</${el.name}>`, i)) {
        i += el.name.length + 3;
        return el;
      }
      if (xml.startsWith('</', i)) throw new Error('mismatched close tag');
      el.children.push(element());
    }
  };
  ws();
  const root = element();
  ws();
  if (i !== xml.length) throw new Error('trailing content');
  return root;
}
function checkJUnitSchema(root: El): void {
  const num = (s: string | undefined) => s !== undefined && /^\d+$/.test(s);
  const time = (s: string | undefined) => s !== undefined && /^\d+(\.\d+)?$/.test(s);
  if (root.name !== 'testsuites') throw new Error('root must be testsuites');
  for (const s of root.children) {
    if (s.name !== 'testsuite') throw new Error('testsuites contains only testsuite');
    const { name, tests, failures, errors, skipped } = s.attrs;
    if (!name || !num(tests) || !num(failures) || !num(errors) || !num(skipped) || !time(s.attrs['time']))
      throw new Error('testsuite attributes');
    if (Number(tests) !== s.children.length) throw new Error('tests count');
    let f = 0;
    let e = 0;
    let k = 0;
    for (const c of s.children) {
      if (
        c.name !== 'testcase' ||
        c.attrs['name'] === undefined ||
        c.attrs['classname'] === undefined ||
        !time(c.attrs['time'])
      )
        throw new Error('testcase attributes');
      if (c.children.length > 1) throw new Error('at most one result element');
      const r = c.children[0];
      if (r && !['failure', 'error', 'skipped'].includes(r.name)) throw new Error('unknown testcase child');
      if (r?.name === 'failure') f++;
      if (r?.name === 'error') e++;
      if (r?.name === 'skipped') k++;
    }
    if (f !== Number(failures) || e !== Number(errors) || k !== Number(skipped)) throw new Error('suite counters');
  }
}

const doc = (names: string[], extra: Partial<JUnitDocument> = {}): JUnitDocument => ({
  name: 'autotest',
  suites: [
    {
      name: 'test/a_test.dart',
      cases: names.map((n, i) => ({
        name: n,
        classname: 'test.a_test',
        outcome: (
          ['passed', 'failed', 'skipped', 'timed_out', 'infra_error', 'blocked', 'not_run', 'cancelled'] as const
        )[i % 8]!,
        ...(i % 8 === 1 ? { failureKind: 'assertion' as const, messageExcerpt: `Expected <3> & got "${n}"` } : {}),
        ...(i % 8 === 5 ? { blockedReason: 'prerequisite_missing:pub_get' } : {}),
        durationMs: i * 7,
      })),
    },
  ],
  ...extra,
});

describe('ADP-002 JUnit writer', () => {
  it('writes schema-conforming JUnit with correct counters for every outcome', () => {
    const xml = toJUnit(doc(['p', 'f', 's', 't', 'i', 'b', 'n', 'c']));
    const root = parseXml(xml);
    checkJUnitSchema(root);
    const suite = root.children[0]!;
    expect(suite.attrs).toMatchObject({ tests: '8', failures: '1', errors: '2', skipped: '4' });
    expect(suite.children[1]!.children[0]).toMatchObject({
      name: 'failure',
      attrs: { type: 'assertion', message: 'Expected <3> & got "f"' },
    });
    expect(suite.children[5]!.children[0]!.attrs['message']).toBe('blocked: prerequisite_missing:pub_get');
    expect(root.attrs).toMatchObject({ tests: '8', failures: '1', errors: '2', skipped: '4' });
    expect(toJUnit(doc(['p', 'f']))).toBe(toJUnit(doc(['p', 'f'])));
  });

  it('escapes markup and control characters so test names cannot inject XML', () => {
    const evil = 'x"/><testcase name="injected"/><!-- & \u0001\u001b\u0000 ]]> \ud800 ￿';
    const xml = toJUnit(doc([evil, evil]));
    const root = parseXml(xml);
    checkJUnitSchema(root);
    expect(root.children[0]!.children).toHaveLength(2);
    expect(root.children[0]!.children[0]!.attrs['name']).toBe(
      'x"/><testcase name="injected"/><!-- & \\x01\\x1b\\x00 ]]> \\xd800 \\xffff',
    );
    expect(xmlEscape('a\tb\nc\r')).toBe('a\tb\nc\r');
    expect(xmlEscape('😀')).toBe('😀');
  });

  it('property: any unicode test name and message yields well-formed, schema-conforming XML that round-trips', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: 'binary', maxLength: 60 }), { minLength: 1, maxLength: 12 }), (names) => {
        const root = parseXml(toJUnit(doc(names)));
        checkJUnitSchema(root);
        return root.children[0]!.children.every(
          (c, i) =>
            c.attrs['name'] ===
            xmlEscape(names[i]!).replace(
              /&(amp|lt|gt|quot|apos);/g,
              (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]!,
            ),
        );
      }),
      { numRuns: 300 },
    );
  });
});
