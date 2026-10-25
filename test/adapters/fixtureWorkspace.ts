/** Shared by the adapter tests: a read-only {@link AdapterWorkspace} over a fixture directory. */
import fs from 'node:fs';
import path from 'node:path';
import type { AdapterWorkspace } from '@autotest/adapter-sdk';

/** A read-only workspace over a fixture directory (globs: `*`, `**`). */
export function fixture(dir: string): AdapterWorkspace {
  const all: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      // Build outputs and Gradle caches a local fixture build may have left are not part of the fixture.
      if (e.isDirectory()) {
        if (e.name !== 'build' && e.name !== '.gradle') walk(r);
      } else all.push(r);
    }
  };
  walk('');
  const re = (g: string) =>
    new RegExp(
      `^${g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\0')
        .replace(/\*/g, '[^/]*')
        .replace(/\0/g, '(?:.*/)?')}$`,
    );
  return {
    readText: (rel, max = 1 << 20) => {
      const text = fs.readFileSync(path.join(dir, rel), 'utf8').slice(0, max);
      return { text, sizeBytes: text.length, truncated: false, binary: false };
    },
    exists: (rel) => fs.existsSync(path.join(dir, rel)),
    list: (globs) => {
      const files = all.filter((f) => globs.some((g) => re(g).test(f)));
      return { files, matched: files.length, truncated: false };
    },
  };
}
