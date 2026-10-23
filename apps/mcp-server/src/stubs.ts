/**
 * Placeholder use cases (MCP-001): every tool is registered and contract-checked, and answers
 * `E_CAPABILITY_UNAVAILABLE` until the task that implements it lands (PLN-*, COV-*, AUTH-004, RUN-*, …).
 */
import { TOOLS, toolError, type ToolName } from '@autotest/core';
import { fail, type UseCases } from '@autotest/workflow';

export function notImplementedUseCases(): UseCases {
  const entries = TOOLS.map((t) => [
    t.name,
    async () =>
      fail(
        toolError(
          'E_CAPABILITY_UNAVAILABLE',
          `${t.name} is not implemented in this build yet`,
          ['Use a build that includes this tool'],
          { tool: t.name },
        ),
      ),
  ]);
  return Object.fromEntries(entries) as unknown as UseCases;
}

/** Replaces the stubs for the tools a build implements. */
export function withUseCases(base: UseCases, implemented: Partial<UseCases>): UseCases {
  return { ...base, ...implemented } as UseCases;
}

export const STUBBED_TOOLS: readonly ToolName[] = TOOLS.map((t) => t.name);
