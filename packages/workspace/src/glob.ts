/**
 * Minimal glob matcher for workspace-relative POSIX paths (WS-001). Supports `**` (any number of segments), `*`
 * (within a segment), `?`, character classes `[abc]` and brace alternatives `{a,b}`. Dotfiles match like any name.
 * Implemented here (no dependency) because patterns come from adapters and repo config, and must never reach a
 * shell or a filesystem API.
 */

const MAX_PATTERN = 512;

export class GlobError extends Error {
  override readonly name = 'GlobError';
}

/** Compiles a glob into an anchored RegExp. Throws {@link GlobError} for absolute, traversing or oversized patterns. */
export function compileGlob(glob: string): RegExp {
  if (glob.length === 0 || glob.length > MAX_PATTERN) throw new GlobError('pattern length out of range');
  if (glob.startsWith('/') || glob.split('/').includes('..') || glob.includes('\0') || glob.includes('\\'))
    throw new GlobError('pattern must be a contained relative path');
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        const atSegmentEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atSegmentStart && atSegmentEnd) {
          // `**/` matches zero or more whole segments; a trailing `**` matches everything below.
          if (glob[i + 2] === '/') {
            re += '(?:[^/]+/)*';
            i += 2;
          } else {
            re += '.*';
            i += 1;
          }
          continue;
        }
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) throw new GlobError('unterminated character class');
      const body = glob
        .slice(i + 1, end)
        .replace(/^!/, '^')
        .replace(/[\\\]]/g, '\\$&');
      re += `[${body}]`;
      i = end;
    } else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (c === ',' && braces > 0) re += '|';
    else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  if (braces !== 0) throw new GlobError('unbalanced braces');
  return new RegExp(`^${re}$`);
}

/** True when `rel` matches any of the compiled patterns. */
export function matchesAny(rel: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(rel));
}
