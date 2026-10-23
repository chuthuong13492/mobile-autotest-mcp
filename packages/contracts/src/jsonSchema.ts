/**
 * JSON Schema (draft 2020-12) generation for tool definitions (ADR-0003 §3).
 * Input schemas use the "input" view (defaults optional); output schemas use the "output" view.
 */
import { z } from 'zod';
import { TOOLS } from './tools.ts';

export interface ToolJsonSchemas {
  readonly id: string;
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
}

/** Returns MCP-ready JSON Schemas for all tools, in catalog order (deterministic, per MCP tools/list guidance). */
export function toToolJsonSchemas(): ToolJsonSchemas[] {
  return TOOLS.map((t) => ({
    id: t.id,
    name: t.name,
    inputSchema: z.toJSONSchema(t.input, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }) as Record<
      string,
      unknown
    >,
    outputSchema: z.toJSONSchema(t.output, {
      target: 'draft-2020-12',
      io: 'output',
      unrepresentable: 'throw',
    }) as Record<string, unknown>,
  }));
}
