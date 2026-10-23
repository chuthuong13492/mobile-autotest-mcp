import { describe, expect, it } from 'vitest';
import { TOOLS } from '@autotest/contracts';
import { readDoc, section } from './docs.ts';

const contracts = readDoc('docs/mcp-tool-contracts.md');

function example(sec: string, label: string): unknown {
  const i = sec.indexOf(`- **${label}:**`);
  if (i < 0) throw new Error(`missing ${label}`);
  const m = /```json\n([\s\S]*?)```/.exec(sec.slice(i));
  if (!m) throw new Error(`no json block for ${label}`);
  return JSON.parse(m[1]!);
}

describe('CON-007 every documented example validates against the Zod schemas', () => {
  for (const t of TOOLS) {
    const sec = section(contracts, `### ${t.id} ${t.name}`);
    it(`${t.id} ${t.name} request`, () => {
      const r = t.input.safeParse(example(sec, 'Example request'));
      expect(r.success ? [] : r.error.issues).toEqual([]);
    });
    it(`${t.id} ${t.name} response`, () => {
      const r = t.output.safeParse(example(sec, 'Example response'));
      expect(r.success ? [] : r.error.issues).toEqual([]);
    });
  }
});
