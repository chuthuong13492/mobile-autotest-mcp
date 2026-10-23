import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, CanonicalizationError, digest, normalizeText } from '@autotest/core';

describe('CORE-002 RFC 8785 canonicalization', () => {
  it('matches the RFC 8785 §3.2.2 example', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts properties by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const keys = ['\u20ac', '\r', '\ufb33', '1', '\ud83d\ude00', '\u0080', '\u00f6'];
    const obj = Object.fromEntries(keys.map((k) => [k, k.length]));
    // Read the order from the canonical text itself: Object.keys() would hoist integer-like keys such as "1".
    const expected = ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33'];
    expect(canonicalize(obj)).toBe(`{${expected.map((k) => `${JSON.stringify(k)}:${k.length}`).join(',')}}`);
  });

  it('serializes numbers the ECMAScript way', () => {
    expect(canonicalize([-0, 1e21, 1e-7, 0.1 + 0.2, 100])).toBe('[0,1e+21,1e-7,0.30000000000000004,100]');
  });

  it('rejects non-I-JSON input', () => {
    for (const bad of [NaN, Infinity, '\ud800', { k: '\udfff' }, [undefined], 10n, new Date(0), new Map()]) {
      expect(() => canonicalize(bad), String(bad)).toThrow(CanonicalizationError);
    }
  });

  it('omits undefined object properties, like JSON.stringify', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('is key-order independent and idempotent (property)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        const c = canonicalize(obj);
        expect(canonicalize(reversed)).toBe(c);
        expect(canonicalize(JSON.parse(c))).toBe(c);
      }),
    );
  });

  it('digest has the sha256:<64 hex> form', () => {
    expect(digest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('normalizes text per the plan-hash spec', () => {
    expect(normalizeText('  Cafe\u0301\t\t is  open\r\nnow  ')).toBe('Café is open\nnow');
  });
});
