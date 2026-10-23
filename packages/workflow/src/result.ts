/** Use-case results (CORE-006). Separate from `index.ts` so use-case modules can import them without a cycle. */
import type { ToolError } from '@autotest/core';

export type UseCaseResult<O> =
  { readonly ok: true; readonly value: O } | { readonly ok: false; readonly error: ToolError };

export const ok = <O>(value: O): UseCaseResult<O> => ({ ok: true, value });
export const fail = <O = never>(error: ToolError): UseCaseResult<O> => ({ ok: false, error });
