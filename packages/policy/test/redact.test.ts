import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  RedactionError,
  coarsenCoordinate,
  createRedactor,
  hashPii,
  hashPiiInText,
  looksSecret,
  type PatternRule,
} from '@autotest/policy';

// Synthetic canaries, assembled at runtime so no literal credential-shaped string sits in the source.
const rep = (c: string, n: number) => c.repeat(n);
const CANARIES: Record<string, string> = {
  github_token: `gh${'p'}_${rep('aB3', 12)}`,
  github_pat: `github_${'pat'}_${rep('Xy9_', 6)}`,
  aws_access_key: `AK${'IA'}${rep('Q7', 8)}`,
  slack_token: `xo${'xb'}-${rep('12ab', 4)}`,
  jwt: `ey${'J'}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${rep('sIg', 4)}`,
  bearer: `Bearer ${rep('tOk3n', 5)}`,
  high_entropy: 'Zq8vR2mXk9LpT4wYb7NcJ3sHd6Fg',
};

describe('POL-005 redaction (ruleset redact-1)', () => {
  it('redacts every canary class and counts findings without values', () => {
    const r = createRedactor();
    const text = [
      `token=${CANARIES['github_token']}`,
      `pat ${CANARIES['github_pat']}`,
      `aws ${CANARIES['aws_access_key']}`,
      `slack ${CANARIES['slack_token']}`,
      `jwt ${CANARIES['jwt']}`,
      `Authorization: ${CANARIES['bearer']}`,
      'clone https://user:hunter22@example.com/repo.git',
      'password: "opensesame"',
      `blob ${CANARIES['high_entropy']} end`,
    ].join('\n');
    const out = r.redact(text);
    for (const v of [...Object.values(CANARIES), 'hunter22', 'opensesame']) expect(out.text).not.toContain(v);
    expect(out.text).toContain('https://[REDACTED:url_credentials]@example.com');
    expect(out.text).toContain('Authorization: Bearer [REDACTED:authorization]');
    expect(out.text).toContain('password: "[REDACTED:credential_assignment]"');
    expect(JSON.stringify(out.findings)).not.toMatch(/hunter|opensesame/);
    expect(Object.values(out.findings).reduce((a, b) => a + (b ?? 0), 0)).toBeGreaterThanOrEqual(9);
  });

  it('redacts known values (longest first) and their encoded forms', () => {
    const r = createRedactor({ knownValues: ['s3cret-Value!', 's3cret', 'ab'] });
    const out = r.redact(
      `a s3cret-Value! b s3cret c ${encodeURIComponent('s3cret-Value!')} d ${Buffer.from('s3cret-Value!').toString('base64')}`,
    );
    expect(out.text).not.toMatch(/s3cret/);
    expect(out.text).not.toContain(encodeURIComponent('s3cret-Value!'));
    expect(out.findings.known_value).toBe(4);
    expect(r.weakKnownValues).toBe(1);
  });

  it('removes private key blocks, also across chunks', () => {
    const block = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      rep('QUJD', 16),
      rep('REVG', 16),
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const text = `before\n${block}\nafter\n`;
    const r = createRedactor();
    expect(r.redact(text).text).toBe('before\n[REDACTED:private_key]\nafter\n');
    const s = r.stream();
    let out = '';
    for (let i = 0; i < text.length; i += 7) out += s.push(text.slice(i, i + 7));
    out += s.end();
    expect(out).toBe('before\n[REDACTED:private_key]\nafter\n');
    expect(r.redact('x -----BEGIN RSA PRIVATE KEY-----abc-----END RSA PRIVATE KEY----- y').text).toBe(
      'x [REDACTED:private_key] y',
    );
  });

  it('does not redact this system’s own formats or ordinary log text', () => {
    const r = createRedactor();
    const benign = [
      'run_01JC5555555555555555555555 plan_01JC5555555555555555555555',
      `sha256:${'ab'.repeat(32)} v1:sha256:${'cd'.repeat(32)}`,
      'TT-flutter-1a2b3c4d5e6f',
      'commit 3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a',
      '00:02 +12: test/widgets/saved_search_badge_test.dart: SavedSearchBadge shows count [E]',
      '/Users/dev/src/app/lib/src/widgets/saved_search_badge/saved_search_badge_widget.dart:42:7',
      'Expected: <3> Actual: <0>',
    ].join('\n');
    const out = r.redact(benign);
    expect(out.text).toBe(benign);
    expect(out.findings).toEqual({});
  });

  it('property: a canary anywhere in a stream, split at any chunk boundaries, never survives', () => {
    const canaries = Object.values(CANARIES).filter((c) => !c.startsWith('Bearer'));
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', 'b', ' ', '\n', '1', '.', ':', '/'), maxLength: 200 }),
        fc.string({ unit: fc.constantFrom('a', 'b', ' ', '\n', '1', '.', ':', '/'), maxLength: 200 }),
        fc.constantFrom(...canaries, 'known-Secret-42'),
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 20 }),
        (pre, post, canary, cuts) => {
          const text = `${pre} ${canary} ${post}`;
          const s = createRedactor({ knownValues: ['known-Secret-42'] }).stream();
          let out = '';
          let i = 0;
          for (const c of cuts) {
            out += s.push(text.slice(i, i + c));
            i += c;
          }
          out += s.push(text.slice(i)) + s.end();
          return !out.includes(canary);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('bounds very long lines and still redacts', () => {
    const long = `${rep('word ', 300_000)}${CANARIES['github_token']} tail`;
    const out = createRedactor().redact(long);
    expect(out.text).not.toContain(CANARIES['github_token']);
  });

  it('fails closed: a throwing rule raises RedactionError', () => {
    const bad: PatternRule = {
      id: 'jwt',
      pattern: {
        [Symbol.replace]: () => {
          throw new Error('boom');
        },
      } as unknown as RegExp,
    };
    expect(() => createRedactor({ rules: [bad] }).redact('x')).toThrow(RedactionError);
  });

  it('entropy heuristic requires three character classes', () => {
    expect(looksSecret('abcdefghijklmnopqrstuvwxyz0123')).toBe(false);
    expect(looksSecret(CANARIES['high_entropy']!)).toBe(true);
  });
});

describe('POL-005 privacy helpers', () => {
  it('coarsens coordinates to one decimal', () => {
    expect(coarsenCoordinate(33.74899)).toBe('33.7');
    expect(coarsenCoordinate(-84.38798)).toBe('-84.4');
    expect(coarsenCoordinate(Number.NaN)).toBe('NaN');
  });

  it('hashes e-mail addresses and international phone numbers, stably per salt', () => {
    const t = hashPiiInText('contact jane.doe@example.com or +1 404-555-0123 at 12:30', 'salt1');
    expect(t).not.toMatch(/jane|555/);
    expect(t).toContain(hashPii('jane.doe@example.com', 'salt1'));
    expect(t).toContain('12:30');
    expect(hashPii('A@B.co', 's')).toBe(hashPii('a@b.co', 's'));
    expect(hashPii('a@b.co', 's')).not.toBe(hashPii('a@b.co', 't'));
  });
});
