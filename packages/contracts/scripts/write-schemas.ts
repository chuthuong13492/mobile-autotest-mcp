/**
 * Writes JSON Schema snapshots for all tools to packages/contracts/schemas (ADR-0003 §3).
 * Run: `node packages/contracts/scripts/write-schemas.ts` (Node ≥24 strips types natively).
 */
import fs from 'node:fs';
import { toToolJsonSchemas } from '../src/jsonSchema.ts';

const dir = new URL('../schemas/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
for (const s of toToolJsonSchemas()) {
  fs.writeFileSync(new URL(`${s.name}.input.json`, dir), JSON.stringify(s.inputSchema, null, 2) + '\n');
  fs.writeFileSync(new URL(`${s.name}.output.json`, dir), JSON.stringify(s.outputSchema, null, 2) + '\n');
}
console.log(`wrote ${toToolJsonSchemas().length * 2} schema files`);
