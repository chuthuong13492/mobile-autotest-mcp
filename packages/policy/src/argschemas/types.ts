/** Argument-schema model used by the executable registry (POL-003; ADR-0014 §3). */

/** Invocation class; execution decides which classes a phase may use. */
export type ExecClass = 'probe' | 'test_runner' | 'build_tool' | 'device_tool';

export type FlagValue =
  | { readonly kind: 'none' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'pattern'; readonly pattern: RegExp }
  /** Value is a run-directory path supplied as a `flagRunPath` token, with an exact prefix (may be empty). */
  | { readonly kind: 'runPath'; readonly prefix: string }
  /** Value is an existing workspace path (rendered absolute) whose relative form matches `pattern`. */
  | { readonly kind: 'workspacePath'; readonly pattern: RegExp };

export interface FlagRule {
  readonly name: string;
  readonly value: FlagValue;
  readonly repeatable?: boolean;
}

/**
 * One positional argument after the form's words, in order: a bare word matching `pattern` (never starting with
 * '-'), or a run-directory path (`runPath` token without a prefix) whose relative path matches `pattern`.
 */
export type Positional =
  { readonly kind: 'word'; readonly pattern: RegExp } | { readonly kind: 'runPath'; readonly pattern: RegExp };

export interface CommandForm {
  readonly id: string;
  readonly class: ExecClass;
  /**
   * A script the interpreter runs, as the very first token: an existing workspace file whose relative path matches
   * (RN-002: `node <ws>/node_modules/jest/bin/jest.js`). Nothing can come before it, so no interpreter option can be
   * passed.
   */
  readonly script?: RegExp;
  /**
   * Flags that must come first, exactly these and in this order, before the words (AND-003: the JVM options before
   * the main class, so no runner flag can reach the JVM and no JVM option can follow).
   */
  readonly leading?: readonly FlagRule[];
  /**
   * Directories under the spec's cwd appended to the end of PATH, when they exist (RN-003: Detox starts its test
   * runner by name, `jest`, from `node_modules/.bin`). System directories stay first, so they win on a name clash.
   */
  readonly cwdPathDirs?: readonly string[];
  /** Exact leading subcommand words. */
  readonly words: readonly string[];
  readonly flags: readonly FlagRule[];
  readonly requiredFlags: readonly string[];
  /** Positional workspace paths: the pattern each relative path must match, or undefined when none are allowed. */
  readonly positionalPaths?: { readonly pattern: RegExp; readonly max: number };
  /** Required positional arguments after the words, all of them, in this order. */
  readonly positionals?: readonly Positional[];
  /** Network-fetching forms; usable only when `execution.allowDependencyResolution` is true (SR-014). */
  readonly gate?: 'dependency_resolution';
}

export interface ArgSchema {
  readonly executable: string;
  /** Fixed environment for every spawn of this executable (RN-003: Maestro's analytics off); policy-owned. */
  readonly env?: Readonly<Record<string, string>>;
  readonly forms: readonly CommandForm[];
  /** Flags denied with a dedicated reason (all other unknown flags are denied as unknown). */
  readonly forbiddenFlags: readonly string[];
}
