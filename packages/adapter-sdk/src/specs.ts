/**
 * ExecutionSpec builders and the run-directory layout adapters write into (ADP-001; ADR-0014). Builders only
 * assemble typed tokens; every spec is parsed against the contract, and policy validates it again before spawning.
 */
import { ExecutionSpec, type ArgToken } from '@autotest/core';

export const word = (value: string): ArgToken => ({ kind: 'word', value });
export const flag = (name: string, value?: string, inline?: boolean): ArgToken => ({
  kind: 'flag',
  name,
  ...(value === undefined ? {} : { value }),
  ...(inline ? { inline } : {}),
});
export const workspacePath = (rel: string): ArgToken => ({ kind: 'workspacePath', rel });
export const runPath = (rel: string, prefix?: string): ArgToken => ({
  kind: 'runPath',
  rel,
  ...(prefix === undefined ? {} : { prefix }),
});
export const flagRunPath = (name: string, rel: string, prefix?: string): ArgToken => ({
  kind: 'flagRunPath',
  name,
  rel,
  ...(prefix === undefined ? {} : { prefix }),
});

/** `attempts/<n>/runner/<file>` — where runner-native outputs go (data model §On-disk layout). */
export function runnerOutput(attemptNo: number, file: string): string {
  if (!Number.isInteger(attemptNo) || attemptNo < 1 || !/^[A-Za-z0-9._-]{1,100}$/.test(file))
    throw new RangeError('invalid runner output name');
  return `attempts/${attemptNo}/runner/${file}`;
}

/** Builds and validates one spec against the contract (throws on a malformed spec: an adapter bug). */
export function buildSpec(spec: ExecutionSpec): ExecutionSpec {
  return ExecutionSpec.parse(spec);
}

/** Stable order for paths passed to a runner (determinism across runs and machines). */
export function sortedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}
