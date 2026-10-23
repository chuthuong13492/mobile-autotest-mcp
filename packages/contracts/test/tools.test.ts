import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS, toToolJsonSchemas } from '@autotest/contracts';
import { readDoc, section } from './docs.ts';

const contracts = readDoc('docs/mcp-tool-contracts.md');
const FORBIDDEN = /^(command|commands|argv|args|shell|script|scripts|cmd|exec|executable)$/i;

/** Collects every property name in a JSON Schema, recursively. */
function propertyNames(schema: unknown, out: string[] = []): string[] {
  if (schema && typeof schema === 'object') {
    const s = schema as Record<string, unknown>;
    if (s.properties && typeof s.properties === 'object') out.push(...Object.keys(s.properties));
    for (const v of Object.values(s)) propertyNames(v, out);
  }
  return out;
}

describe('CON-007 tool registry', () => {
  it('has exactly the 18 catalog tools with matching IDs, names and tiers', () => {
    const rows = [
      ...section(contracts, '## 1. Catalog').matchAll(
        /^\| (TL-\d{2}) \| `([a-z_]+)` \| (P[0-3](?:\/P[0-3])?)[^|]* \|/gm,
      ),
    ];
    expect(rows).toHaveLength(18);
    expect(TOOLS).toHaveLength(18);
    rows.forEach(([, id, name, tier], i) => {
      expect(TOOLS[i]!.id).toBe(id);
      expect(TOOLS[i]!.name).toBe(name);
      expect(TOOLS[i]!.tier.join('/')).toBe(tier);
    });
  });

  it('annotations and requiresUserInteraction match each contract section', () => {
    for (const t of TOOLS) {
      const sec = section(contracts, `### ${t.id} ${t.name}`);
      const line = /\*\*MCP annotations \(advisory\):\*\* (.*)/.exec(sec)?.[1] ?? '';
      for (const [k, v] of Object.entries(t.annotations))
        expect(line, `${t.id} ${k}`).toContain(`\`${k}: ${String(v)}\``);
      expect(line.includes('requiresUserInteraction'), t.id).toBe(t.requiresUserInteraction);
    }
  });

  it('input schemas are strict objects at the root with no root combinators (ADR-0003)', () => {
    for (const s of toToolJsonSchemas()) {
      for (const schema of [s.inputSchema, s.outputSchema]) {
        expect(schema.type, s.name).toBe('object');
        for (const k of ['anyOf', 'oneOf', 'allOf']) expect(schema[k], `${s.name} root ${k}`).toBeUndefined();
      }
      expect(s.inputSchema.additionalProperties, s.name).toBe(false);
    }
  });

  it('no input field anywhere can carry a command, argv or script (SR-001)', () => {
    for (const s of toToolJsonSchemas()) {
      const bad = propertyNames(s.inputSchema).filter((n) => FORBIDDEN.test(n));
      expect(bad, s.name).toEqual([]);
    }
  });

  it('rejects unknown input fields (strict)', () => {
    const r = TOOLS[8]!.input.safeParse({
      planId: 'plan_01JC0000000000000000000005',
      planHash: `v1:sha256:${'a'.repeat(64)}`,
      command: 'rm -rf /',
    });
    expect(r.success).toBe(false);
  });

  it('JSON Schema generation is deterministic', () => {
    expect(JSON.stringify(toToolJsonSchemas())).toBe(JSON.stringify(toToolJsonSchemas()));
    expect(z.toJSONSchema(TOOLS[0]!.input, { io: 'input' })).toBeTruthy();
  });
});
