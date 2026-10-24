#!/usr/bin/env node
/* global process, console */
/**
 * OPS-002: every relative Markdown link in the repository resolves — the file exists, and a `#fragment` matches a
 * heading of that file (GitHub's anchor rules). External links (http, https, mailto) are not fetched. Links inside
 * code fences and inline code are ignored. Exit code 1 lists every broken link as `file:line → target (reason)`.
 * Run: `node scripts/check-doc-links.mjs` (part of `pnpm check`).
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP = new Set([
  'node_modules',
  '.git',
  'out',
  'results',
  'graphify-out',
  'coverage',
  'dist',
  '.dart_tool',
  'build',
]);

function* markdownFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* markdownFiles(p);
    else if (e.name.endsWith('.md')) yield p;
  }
}

/** Lines outside fenced code blocks, with inline code removed (or kept, for headings). */
function proseLines(text, keepCode = false) {
  const out = [];
  let fence = null;
  for (const [i, line] of text.split('\n').entries()) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (!fence) out.push([i + 1, keepCode ? line : line.replace(/`[^`]*`/g, '')]);
  }
  return out;
}

/** GitHub heading anchors of a Markdown file. */
const anchorCache = new Map();
function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const seen = new Map();
  const set = new Set();
  for (const [, line] of proseLines(fs.readFileSync(file, 'utf8'), true)) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = h[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    set.add(n === 0 ? base : `${base}-${n}`);
  }
  // Explicit HTML anchors (`<a id="x">`) count too.
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(m[1]);
  anchorCache.set(file, set);
  return set;
}

const broken = [];
let checked = 0;
for (const file of markdownFiles(ROOT)) {
  for (const [lineNo, line] of proseLines(fs.readFileSync(file, 'utf8'))) {
    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|tel:)/i.test(target)) continue;
      checked++;
      const [rawPath, fragment] = target.split('#');
      const rel = decodeURIComponent(rawPath ?? '');
      const dest = rel ? path.resolve(path.dirname(file), rel) : file;
      const where = `${path.relative(ROOT, file)}:${lineNo}`;
      if (!fs.existsSync(dest)) {
        broken.push(`${where} → ${target} (no such file)`);
        continue;
      }
      if (fragment && dest.endsWith('.md') && !anchors(dest).has(decodeURIComponent(fragment).toLowerCase()))
        broken.push(`${where} → ${target} (no such heading)`);
    }
  }
}
if (broken.length) {
  console.error(`${broken.length} broken link(s) of ${checked}:\n${broken.join('\n')}`);
  process.exit(1);
}
console.log(`doc links: ${checked} relative links OK`);
