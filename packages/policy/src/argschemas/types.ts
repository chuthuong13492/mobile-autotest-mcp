/** Argument-schema model used by the executable registry (POL-003; ADR-0014 §3). */

/** Invocation class; execution decides which classes a phase may use. */
export type ExecClass = 'probe' | 'test_runner' | 'build_tool' | 'device_tool';

export type FlagValue =
  | { readonly kind: 'none' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'pattern'; readonly pattern: RegExp }
  /** Value is a run-directory path supplied as a `flagRunPath` token, with an exact prefix (may be empty). */
  | { readonly kind: 'runPath'; readonly prefix: string };

export interface FlagRule {
  readonly name: string;
  readonly value: FlagValue;
  readonly repeatable?: boolean;
}

export interface CommandForm {
  readonly id: string;
  readonly class: ExecClass;
  /** Exact leading subcommand words. */
  readonly words: readonly string[];
  readonly flags: readonly FlagRule[];
  readonly requiredFlags: readonly string[];
  /** Positional workspace paths: the pattern each relative path must match, or undefined when none are allowed. */
  readonly positionalPaths?: { readonly pattern: RegExp; readonly max: number };
  /** Network-fetching forms; usable only when `execution.allowDependencyResolution` is true (SR-014). */
  readonly gate?: 'dependency_resolution';
}

export interface ArgSchema {
  readonly executable: string;
  readonly forms: readonly CommandForm[];
  /** Flags denied with a dedicated reason (all other unknown flags are denied as unknown). */
  readonly forbiddenFlags: readonly string[];
}
