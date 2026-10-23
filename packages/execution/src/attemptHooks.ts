/**
 * Adapter-driven attempt hooks (RUN-002, RUN-005): build later attempts' specs and parse each attempt through the
 * adapter that owns the run's targets. Adapters stay pure; this module reads the runner files for them.
 */
import { fillNotRun, type AdapterRegistry, type NormalizedResult } from '@autotest/adapter-sdk';
import type { ExecutionSpec, TestTarget } from '@autotest/core';
import type { RunHeader } from './supervisor/files.ts';
import { readRunnerOutputs } from './runnerOutputs.ts';

export interface AttemptParse {
  readonly results: readonly NormalizedResult[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
  readonly protocol?: string;
}

export interface AttemptHooks {
  buildSpecs(header: RunHeader, attemptNo: number, targets: readonly TestTarget[]): ExecutionSpec[];
  parseAttempt(args: {
    readonly header: RunHeader;
    readonly runDir: string;
    readonly attemptNo: number;
    readonly targets: readonly TestTarget[];
    readonly processes: readonly { readonly exitCode?: number; readonly signal?: string }[];
    readonly interrupted: boolean;
  }): AttemptParse;
}

export function adapterAttemptHooks(registry: AdapterRegistry): AttemptHooks {
  const adapterFor = (header: RunHeader) => {
    const id = header.execution?.adapterId;
    const a = id ? registry.get(id) : undefined;
    if (!a) throw new Error(`adapter ${id ?? '(none)'} is not available to the supervisor`);
    return a;
  };
  return {
    buildSpecs(header, attemptNo, targets) {
      return adapterFor(header).buildExecution({
        attemptNo,
        targets,
        options: { coverage: header.execution?.coverage ?? false, timeoutMs: header.timeouts.runMs },
      });
    },
    parseAttempt({ header, runDir, attemptNo, targets, processes, interrupted }) {
      const parsed = adapterFor(header).parseResults({
        attemptNo,
        targets,
        files: readRunnerOutputs(runDir, attemptNo),
        processes,
        interrupted,
      });
      // Every target of the attempt is accounted for: a target without results did not run.
      return {
        results: fillNotRun(
          targets.map((t) => t.id),
          parsed.results,
        ),
        diagnostics: parsed.diagnostics,
        ...(parsed.protocol ? { protocol: parsed.protocol } : {}),
      };
    },
  };
}
