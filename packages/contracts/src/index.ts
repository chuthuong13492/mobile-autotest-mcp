/**
 * @autotest/contracts — the single source of contract truth (ADR-0003).
 * Every external or persisted shape is a Zod 4 schema here; TypeScript types are inferred from them.
 */
export * from './enums.ts';
export * from './errors.ts';
export * from './common.ts';
export * from './entities.ts';
export * from './tools.ts';
export * from './canonical.ts';
export * from './planHash.ts';
export * from './execution.ts';
export { toToolJsonSchemas, type ToolJsonSchemas } from './jsonSchema.ts';
