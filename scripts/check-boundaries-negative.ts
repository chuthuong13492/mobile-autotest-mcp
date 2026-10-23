/**
 * OPS-003: proves every dependency-cruiser rule actually fires, using deliberately violating fixtures in
 * test/boundaries-negative, and that the ESLint non-literal dynamic import rule fires (test/lint-negative).
 * Exits non-zero if any expected violation is missing or an unexpected one appears.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const fixtureDir = path.join(root, 'test/boundaries-negative');
const bin = (name: string) => path.join(root, 'node_modules/.bin', name);
let failures = 0;

interface Violation {
  from: string;
  rule: { name: string };
}
const out = (() => {
  try {
    return execFileSync(
      bin('depcruise'),
      ['--config', path.join(root, '.dependency-cruiser.cjs'), '--output-type', 'json', 'packages', 'apps'],
      { cwd: fixtureDir, encoding: 'utf8' },
    );
  } catch (e) {
    return (e as { stdout: string }).stdout; // depcruise exits non-zero when violations exist (expected here)
  }
})();
const violations = (JSON.parse(out) as { summary: { violations: Violation[] } }).summary.violations;
const expected = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'expected.json'), 'utf8')) as Record<
  string,
  string[] | string
>;

for (const [file, rules] of Object.entries(expected)) {
  if (file.startsWith('$')) continue;
  const got = new Set(violations.filter((v) => v.from === file).map((v) => v.rule.name));
  for (const r of rules as string[]) {
    if (!got.has(r)) {
      console.error(`MISSING  ${file}: expected rule ${r} (got: ${[...got].join(', ') || 'none'})`);
      failures++;
    } else console.log(`ok       ${file}: ${r}`);
  }
  if ((rules as string[]).length === 0 && got.size > 0) {
    console.error(`UNEXPECTED ${file}: ${[...got].join(', ')}`);
    failures++;
  }
}
const firedRules = new Set(violations.map((v) => v.rule.name.split(':')[0]));
const configRules = new Set(
  (require(path.join(root, '.dependency-cruiser.cjs')) as { forbidden: { name: string }[] }).forbidden.map(
    (r) => r.name.split(':')[0],
  ),
);
for (const r of configRules)
  if (!firedRules.has(r)) {
    console.error(`RULE NEVER EXERCISED: ${r}`);
    failures++;
  }

// ESLint: non-literal dynamic import must be rejected (ADR-0015).
try {
  execFileSync(bin('eslint'), ['--no-ignore', '--format', 'json', 'test/lint-negative/non-literal-dynamic-import.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  console.error('MISSING  eslint did not reject a non-literal dynamic import');
  failures++;
} catch (e) {
  const res = JSON.parse((e as { stdout: string }).stdout) as { messages: { ruleId: string }[] }[];
  if (res[0]?.messages.some((m) => m.ruleId === 'no-restricted-syntax'))
    console.log('ok       eslint: non-literal dynamic import rejected');
  else {
    console.error('MISSING  eslint no-restricted-syntax');
    failures++;
  }
}

console.log(
  failures ? `\n${failures} negative-fixture failure(s)` : '\nall boundary rules verified by negative fixtures',
);
process.exit(failures ? 1 : 0);
