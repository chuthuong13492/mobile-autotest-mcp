/**
 * Canonical error catalog (CON-002).
 *
 * Source of truth: docs/mcp-tool-contracts.md §3 (codes, recoverability) and
 * docs/observability-and-failure-analysis.md §3 (categories). `errors.docsync.test.ts` enforces agreement.
 * Domain errors are returned as MCP tool execution errors (`isError: true`) whose structuredContent is {@link ToolError}.
 */
import { z } from 'zod';

/** Recoverability as documented: `yes_human` / `no_human` mean a human must act. */
export type Recoverability = 'yes' | 'yes_human' | 'no' | 'no_human' | 'depends';
export type ErrorCategory = 'input' | 'lifecycle' | 'policy' | 'environment' | 'evidence' | 'external' | 'internal';

interface ErrorMeta {
  readonly recoverability: Recoverability;
  readonly category: ErrorCategory;
}

export const ERROR_CATALOG = {
  E_VALIDATION: { recoverability: 'yes', category: 'input' },
  E_INPUT_TOO_LARGE: { recoverability: 'yes', category: 'input' },
  E_CURSOR_INVALID: { recoverability: 'yes', category: 'input' },
  E_NOT_FOUND: { recoverability: 'yes', category: 'lifecycle' },
  E_PLAN_NOT_FOUND: { recoverability: 'yes', category: 'lifecycle' },
  E_RUN_NOT_FOUND: { recoverability: 'no', category: 'lifecycle' },
  E_WORKSPACE_NOT_ALLOWED: { recoverability: 'yes_human', category: 'policy' },
  E_REPO_MISMATCH: { recoverability: 'yes', category: 'policy' },
  E_PATH_ESCAPE: { recoverability: 'no', category: 'policy' },
  E_POLICY_DENIED: { recoverability: 'depends', category: 'policy' },
  E_POLICY_UNAVAILABLE: { recoverability: 'yes_human', category: 'policy' },
  E_PLAN_HASH_MISMATCH: { recoverability: 'no', category: 'policy' },
  E_COVERAGE_MISSING: { recoverability: 'yes', category: 'policy' },
  E_COVERAGE_STALE: { recoverability: 'yes', category: 'policy' },
  E_COVERAGE_FAILED: { recoverability: 'yes', category: 'policy' },
  E_APPROVAL_REQUIRED: { recoverability: 'yes_human', category: 'policy' },
  E_APPROVAL_STALE: { recoverability: 'yes_human', category: 'policy' },
  E_APPROVAL_EXPIRED: { recoverability: 'yes_human', category: 'policy' },
  E_APPROVAL_REVOKED: { recoverability: 'yes_human', category: 'policy' },
  E_APPROVAL_EXHAUSTED: { recoverability: 'yes_human', category: 'policy' },
  E_ASSURANCE_INSUFFICIENT: { recoverability: 'yes_human', category: 'policy' },
  E_AUTHORIZATION_CHANGED: { recoverability: 'yes', category: 'policy' },
  E_PREREQUISITE_MISSING: { recoverability: 'yes_human', category: 'environment' },
  E_CAPABILITY_UNAVAILABLE: { recoverability: 'no', category: 'environment' },
  E_UNSUPPORTED_PLATFORM: { recoverability: 'no', category: 'environment' },
  E_DEVICE_UNAVAILABLE: { recoverability: 'yes', category: 'environment' },
  E_DEVICE_NOT_OWNED: { recoverability: 'yes_human', category: 'policy' },
  E_QUEUE_FULL: { recoverability: 'yes', category: 'environment' },
  E_RUN_TERMINAL: { recoverability: 'no', category: 'lifecycle' },
  E_REPORT_NOT_READY: { recoverability: 'yes', category: 'lifecycle' },
  E_IDEMPOTENCY_CONFLICT: { recoverability: 'yes', category: 'input' },
  E_ARTIFACT_TOO_LARGE: { recoverability: 'no', category: 'evidence' },
  E_ARTIFACT_QUARANTINED: { recoverability: 'no', category: 'evidence' },
  E_REDACTION_FAILED: { recoverability: 'no', category: 'evidence' },
  E_ELICITATION_DECLINED: { recoverability: 'yes', category: 'internal' },
  E_GITHUB_UNAVAILABLE: { recoverability: 'yes', category: 'external' },
  E_GITHUB_AUTH: { recoverability: 'yes_human', category: 'external' },
  E_GITHUB_PERMISSION: { recoverability: 'yes_human', category: 'external' },
  E_GITHUB_RATE_LIMITED: { recoverability: 'yes', category: 'external' },
  E_GITHUB_FEATURE_UNAVAILABLE: { recoverability: 'yes', category: 'external' },
  E_GITHUB_NOT_FOUND: { recoverability: 'yes', category: 'external' },
  E_STORAGE_UNAVAILABLE: { recoverability: 'yes', category: 'internal' },
  E_STORAGE_CORRUPT: { recoverability: 'no_human', category: 'internal' },
  E_TIMEOUT: { recoverability: 'yes', category: 'environment' },
  E_INTERNAL: { recoverability: 'no', category: 'internal' },
} as const satisfies Record<string, ErrorMeta>;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as [
  keyof typeof ERROR_CATALOG,
  ...(keyof typeof ERROR_CATALOG)[],
];
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Whether the agent (or a human, for `*_human`) can recover by changing input or acting; `depends` maps to true. */
export function isRecoverable(code: ErrorCode): boolean {
  const r: Recoverability = ERROR_CATALOG[code].recoverability;
  return r === 'yes' || r === 'yes_human' || r === 'depends';
}

/** structuredContent of every domain tool error (mcp-tool-contracts §2.1). */
export const ToolError = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string().max(1000),
    recoverable: z.boolean(),
    nextSteps: z.array(z.string().max(300)).max(5),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ToolError = z.infer<typeof ToolError>;

/** Builds a schema-valid {@link ToolError}; messages are truncated, never interpolated with unbounded input. */
export function toolError(
  code: ErrorCode,
  message: string,
  nextSteps: readonly string[] = [],
  details?: Record<string, unknown>,
): ToolError {
  return ToolError.parse({
    error: {
      code,
      message: message.slice(0, 1000),
      recoverable: isRecoverable(code),
      nextSteps: nextSteps.slice(0, 5).map((s) => s.slice(0, 300)),
      ...(details === undefined ? {} : { details }),
    },
  });
}
