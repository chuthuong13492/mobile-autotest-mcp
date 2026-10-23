/**
 * OPS-003: boundaries.json must agree with (a) every workspace package.json's @autotest dependencies and
 * (b) the "Allowed dependencies" column of docs/architecture.md §Packages and dependency rules.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const boundaries = JSON.parse(fs.readFileSync(path.join(root, 'boundaries.json'), 'utf8')) as Record<
  string,
  string[] | string
>;
const units = Object.keys(boundaries).filter((k) => !k.startsWith('$'));
const pkgs = units.filter((u) => u.startsWith('packages/'));
const short = (u: string) => u.split('/')[1]!;
let failures = 0;
const fail = (m: string) => {
  console.error(`FAIL ${m}`);
  failures++;
};
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// (a) package.json dependencies
for (const u of units) {
  const allowed = boundaries[u] === '*' ? pkgs : (boundaries[u] as string[]);
  const pj = JSON.parse(fs.readFileSync(path.join(root, u, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const declared = Object.keys(pj.dependencies ?? {})
    .filter((d) => d.startsWith('@autotest/'))
    .map((d) => `packages/${d.slice('@autotest/'.length)}`);
  if (!same(declared, allowed)) fail(`${u}/package.json @autotest deps [${declared}] != boundaries [${allowed}]`);
}

// (b) architecture.md table
const arch = fs.readFileSync(path.join(root, 'docs/architecture.md'), 'utf8');
const rows = new Map<string, string>();
for (const m of arch.matchAll(/^\| `((?:packages|apps)\/[a-z-]+)` \|.*\| ([^|]+) \|$/gm)) rows.set(m[1]!, m[2]!.trim());
for (const u of units) {
  const cell = rows.get(u);
  if (cell === undefined) {
    fail(`${u} missing from architecture.md table`);
    continue;
  }
  if (boundaries[u] === '*') {
    if (!/all packages/i.test(cell)) fail(`${u}: doc says "${cell}", boundaries say all packages`);
    continue;
  }
  // Strip "only through injected ports"/"must not depend on" clauses, then collect package names mentioned.
  const positive = cell.replace(/\(.*?\)/g, '').replace(/\*\*Must not depend on [a-z-]+\.\*\*/g, '');
  const named = pkgs.filter((p) => new RegExp(`(^|[^a-z-])${short(p)}([^a-z-]|$)`).test(positive));
  if (!same(named, boundaries[u] as string[]))
    fail(`${u}: doc [${named.map(short)}] != boundaries [${(boundaries[u] as string[]).map(short)}]`);
}
console.log(
  failures
    ? `${failures} boundary consistency failure(s)`
    : `boundaries.json consistent with ${units.length} package.json files and docs/architecture.md`,
);
process.exit(failures ? 1 : 0);
