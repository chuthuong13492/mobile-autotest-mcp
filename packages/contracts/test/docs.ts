/** Test helper: read canonical planning docs relative to the repository root. */
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
export const readDoc = (rel: string): string => fs.readFileSync(new URL(rel, root), 'utf8');

/** Returns the text between a heading line that starts with `start` and the next heading of the same or higher level. */
export function section(doc: string, start: string): string {
  const lines = doc.split('\n');
  const i = lines.findIndex((l) => l.startsWith(start));
  if (i < 0) throw new Error(`section not found: ${start}`);
  const level = (lines[i]!.match(/^#+/) ?? [''])[0].length;
  const end = lines.findIndex((l, j) => j > i && /^#+ /.test(l) && (l.match(/^#+/) ?? [''])[0].length <= level);
  return lines.slice(i + 1, end < 0 ? undefined : end).join('\n');
}

/** Backticked identifiers found in the first cell of markdown table rows. */
export const firstCellCodes = (text: string): string[] => [...text.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
