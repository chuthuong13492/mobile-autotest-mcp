import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toToolJsonSchemas } from '@autotest/contracts';

const dir = new URL('../schemas/', import.meta.url);

describe('CON-007 committed JSON Schema snapshots match the Zod contracts', () => {
  for (const s of toToolJsonSchemas()) {
    it(s.name, () => {
      for (const [kind, schema] of [
        ['input', s.inputSchema],
        ['output', s.outputSchema],
      ] as const) {
        const file = new URL(`${s.name}.${kind}.json`, dir);
        expect(fs.existsSync(file), `${s.name}.${kind}.json missing — run scripts/write-schemas.ts`).toBe(true);
        expect(
          JSON.parse(fs.readFileSync(file, 'utf8')),
          `${s.name}.${kind} drifted — regenerate and bump the contract version`,
        ).toEqual(schema);
      }
    });
  }
});
