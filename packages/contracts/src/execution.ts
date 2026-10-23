/**
 * ExecutionSpec — the typed, shell-free description of one process to run (ADR-0009, ADR-0014).
 *
 * Adapters build specs; `@autotest/policy` validates them against the executable registry and per-executable
 * argument schemas; `@autotest/exec` re-validates and spawns. No field ever carries a shell string: arguments are
 * typed tokens, and paths are relative to a root that policy resolves and contains.
 */
import { z } from 'zod';
import { ArtifactKind, DeviceNeed, HostRequirement } from './enums.ts';

/** Logical executable names are mapped to absolute paths by policy, never looked up on PATH at spawn time. */
export const LogicalExecutable = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type LogicalExecutable = z.infer<typeof LogicalExecutable>;

const RelPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) => !p.startsWith('/') && !p.split(/[\\/]/).includes('..') && !p.includes('\0'),
    'must be a contained relative path',
  );

const SafeText = z
  .string()
  .max(2048)
  .refine((s) => !/[\0\r\n]/.test(s), 'NUL and newline characters are not allowed in arguments');

/** One argv element. Paths stay symbolic until policy resolves them inside an allowed root. */
export const ArgToken = z.discriminatedUnion('kind', [
  /** A subcommand or bare word, e.g. `test`. */
  z.strictObject({ kind: z.literal('word'), value: SafeText }),
  /** `--name` or `--name <value>`; `inline: true` renders `--name=value`. */
  z.strictObject({
    kind: z.literal('flag'),
    name: z.string().regex(/^-{1,2}[a-zA-Z][a-zA-Z0-9-]*$/),
    value: SafeText.optional(),
    inline: z.boolean().optional(),
  }),
  /** A path inside the workspace (e.g. a test file). */
  z.strictObject({ kind: z.literal('workspacePath'), rel: RelPath }),
  /** A path inside the run directory (e.g. a reporter output file). `prefix` is prepended verbatim (e.g. `json:`). */
  z.strictObject({
    kind: z.literal('runPath'),
    rel: RelPath,
    prefix: z
      .string()
      .regex(/^[a-z]{0,16}:?$/)
      .optional(),
  }),
  /** A flag whose value is a run-directory path: `--coverage-path <runDir>/rel`. */
  z.strictObject({
    kind: z.literal('flagRunPath'),
    name: z.string().regex(/^-{1,2}[a-zA-Z][a-zA-Z0-9-]*$/),
    rel: RelPath,
    prefix: z
      .string()
      .regex(/^[a-z]{0,16}:?$/)
      .optional(),
  }),
]);
export type ArgToken = z.infer<typeof ArgToken>;

export const ExecutionSpec = z.strictObject({
  executable: LogicalExecutable,
  args: z.array(ArgToken).max(500),
  /** Working directory relative to the workspace root; '.' for the root. */
  cwd: z.union([z.literal('.'), RelPath]),
  /** Environment variable names the process needs; values come from the env allowlist or secret references. */
  envNeeds: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).max(50),
  expectedOutputs: z.array(z.strictObject({ kind: ArtifactKind, rel: RelPath })).max(50),
  timeoutMs: z.number().int().min(1000).max(14_400_000),
  cancellation: z.enum(['process_group', 'graceful_then_group']),
  requires: z.strictObject({ host: HostRequirement, device: DeviceNeed }),
});
export type ExecutionSpec = z.infer<typeof ExecutionSpec>;
