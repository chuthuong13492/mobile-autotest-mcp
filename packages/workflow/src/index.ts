/**
 * @autotest/workflow — shared use-case orchestration for apps/mcp-server and apps/cli (CORE-006; architecture §Packages).
 *
 * Holds sequencing only, never business rules. Its one runtime responsibility is the contract boundary:
 * {@link bindUseCases} validates every input against the tool's Zod schema before a use case runs and every output
 * after it returns, so both apps share one enforcement point (ADR-0003, NFR-013).
 */
import { TOOLS, toolError, type ToolInput, type ToolName, type ToolOutput } from '@autotest/core';

export type { CallContext, WorkflowPorts } from './ports.ts';
import type { CallContext } from './ports.ts';

import { fail, ok, type UseCaseResult } from './result.ts';
export { fail, ok, type UseCaseResult } from './result.ts';
export type UseCase<I, O> = (input: I, ctx: CallContext) => Promise<UseCaseResult<O>>;

/** One use case per catalog tool; the mapped type makes a missing or mistyped tool a compile error. */
export type UseCases = { readonly [N in ToolName]: UseCase<ToolInput<N>, ToolOutput<N>> };
/** The bound, boundary-validated surface the apps call with raw (untrusted) input. */
export type Workflow = {
  readonly [N in ToolName]: (rawInput: unknown, ctx: CallContext) => Promise<UseCaseResult<ToolOutput<N>>>;
};

/** JSON pointer for a Zod issue path (e.g. `/draft/testCases/0/steps`). */
const pointer = (path: readonly PropertyKey[]): string =>
  path.length ? `/${path.map((p) => String(p).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}` : '/';

/**
 * Wraps use cases with contract enforcement:
 * - input failing its schema → `E_VALIDATION` with JSON-pointer issues (the use case never runs);
 * - output failing its schema → `E_INTERNAL` (a server bug; the invalid output is never returned);
 * - a thrown exception → `E_INTERNAL` with a correlation id, never the raw message.
 */
export function bindUseCases(useCases: UseCases): Workflow {
  const missing = TOOLS.map((t) => t.name).filter(
    (n) => typeof (useCases as Record<string, unknown>)[n] !== 'function',
  );
  if (missing.length) throw new Error(`missing use cases: ${missing.join(', ')}`);

  const bound: Record<string, (raw: unknown, ctx: CallContext) => Promise<UseCaseResult<unknown>>> = {};
  for (const tool of TOOLS) {
    const useCase = useCases[tool.name] as UseCase<unknown, unknown>;
    bound[tool.name] = async (raw, ctx) => {
      const parsed = tool.input.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 20)
          .map((i) => ({ pointer: pointer(i.path), message: i.message.slice(0, 200) }));
        return fail(
          toolError(
            'E_VALIDATION',
            `Invalid input for ${tool.name}`,
            ['Fix the fields listed in details.issues and retry'],
            { issues },
          ),
        );
      }
      let result: UseCaseResult<unknown>;
      try {
        result = await useCase(parsed.data, ctx);
      } catch {
        return fail(
          toolError('E_INTERNAL', `Unexpected error in ${tool.name}`, ['Report this with the correlation id'], {
            correlationId: ctx.toolCallId,
          }),
        );
      }
      if (!result.ok) return result;
      const checked = tool.output.safeParse(result.value);
      if (!checked.success) {
        return fail(
          toolError(
            'E_INTERNAL',
            `${tool.name} produced output that violates its contract`,
            ['Report this with the correlation id'],
            { correlationId: ctx.toolCallId },
          ),
        );
      }
      return ok(checked.data);
    };
  }
  return bound as Workflow;
}

export * from './intake.ts';
export * from './environment.ts';
export * from './approvals.ts';
export * from './run.ts';
export * from './evidence.ts';
export * from './analysis.ts';
export * from './report.ts';
