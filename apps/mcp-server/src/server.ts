/**
 * MCP server construction (MCP-001; ADR-0001, ADR-0003; NFR-010, SR-017).
 *
 * All 18 catalog tools are registered in catalog order (`TOOLS`), so `tools/list` is deterministic. Each tool is
 * registered with a pass-through Standard Schema that *advertises* the contract's JSON Schema but does not
 * validate: validation belongs to the shared contract boundary (`bindUseCases`), which returns the documented
 * `E_VALIDATION` tool error with JSON-pointer issues instead of the SDK's unstructured protocol message. Every call
 * runs through the tool middleware (`middleware/pipeline.ts`). Only stdio is used; no HTTP listener exists here.
 */
import { McpServer, type ServerContext, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { TOOLS, toToolJsonSchemas, type ToolName } from '@autotest/core';
import { TOOL_DESCRIPTIONS } from './descriptions.ts';
import type { ToolPipeline, ToolResult } from './middleware/pipeline.ts';

export const SERVER_NAME = 'autotest';

/** A Standard Schema that accepts any value and reports the given JSON Schema for listing. */
export function advertisedSchema(json: Record<string, unknown>): StandardSchemaWithJSON {
  return {
    '~standard': {
      version: 1,
      vendor: 'autotest',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => json, output: () => json },
    },
  } as StandardSchemaWithJSON;
}

export interface ServerDeps {
  readonly call: ToolPipeline;
  readonly version: string;
  /** Protocol-level follow-up for a tool result (used for `request_approval` elicitation). */
  readonly postProcess?: (
    name: ToolName,
    args: unknown,
    result: ToolResult,
    ctx: ServerContext,
    server: McpServer,
  ) => Promise<ToolResult>;
}

export function createAutotestServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: deps.version });
  const schemas = new Map(toToolJsonSchemas().map((s) => [s.name, s]));
  for (const tool of TOOLS) {
    const json = schemas.get(tool.name)!;
    server.registerTool(
      tool.name,
      {
        description: TOOL_DESCRIPTIONS[tool.name],
        inputSchema: advertisedSchema(json.inputSchema),
        outputSchema: advertisedSchema(json.outputSchema),
        annotations: { ...tool.annotations },
        ...(tool.requiresUserInteraction ? { _meta: { 'anthropic/requiresUserInteraction': true } } : {}),
      },
      async (args: unknown, ctx: ServerContext) => {
        const result = await deps.call(tool.name, args);
        return deps.postProcess ? deps.postProcess(tool.name, args, result, ctx, server) : result;
      },
    );
  }
  return server;
}
