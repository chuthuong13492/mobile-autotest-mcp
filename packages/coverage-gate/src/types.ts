/**
 * Gate inputs (COV-001 – COV-003; ADR-0005). The gate is independent of `planning`: it reads only persisted,
 * schema-validated entities (never `display.*`) and a structural copy of the `coverageGate` policy section.
 */
import type {
  ChangedFile,
  CoverageException,
  GateFinding,
  RequirementSet,
  TestOutcome,
  TestPlan,
  TestTarget,
} from '@autotest/core';

export interface GateConfig {
  readonly thresholds: {
    readonly requirementCoverageMin: number;
    readonly testCaseCoverageMin: number;
    readonly platformCoverageMin: number;
    readonly regressionCoverageMin: number;
  };
  readonly rules: {
    readonly 'GR-02': {
      readonly enabled: boolean;
      readonly vagueTerms: readonly string[];
      readonly observableVerbs: readonly string[];
    };
    readonly 'GR-03': { readonly enabled: boolean };
    readonly 'GR-05': { readonly enabled: boolean };
    readonly 'GR-06': { readonly enabled: boolean };
    readonly 'GR-08': { readonly enabled: boolean };
    readonly 'GR-09': { readonly enabled: boolean; readonly depth: number };
    readonly 'GR-10': { readonly promote: boolean };
  };
  readonly exceptionMaxDays: number;
}

/** Run data for post-execution metrics and status (optional before execution). */
export interface RunData {
  /** Final outcome per test case id. */
  readonly outcomes: ReadonlyMap<string, TestOutcome>;
  /** TestTarget ids that executed in the run (for `covered_elsewhere` exceptions). */
  readonly executedTargets: ReadonlySet<string>;
  /** Changed-line coverage from lcov ∩ changed files, when collected. */
  readonly sourceCoverage?: { readonly covered: number; readonly instrumentable: number };
}

export interface GateInput {
  readonly plan: TestPlan;
  readonly requirementSet: RequirementSet;
  readonly config: GateConfig;
  /** Inventory targets of the plan's snapshot (for `covered_elsewhere` links and GR-09). */
  readonly targets: readonly TestTarget[];
  /** Exception ids with a usable approval at the required assurance (verified by the caller through policy). */
  readonly approvedExceptions: ReadonlySet<string>;
  /** Undefined when the PR's changed files are unknown (INF-02). */
  readonly changedFiles?: readonly ChangedFile[];
  readonly now: Date;
  readonly run?: RunData;
}

export type Finding = GateFinding;

export interface ExceptionCheck {
  readonly exception: CoverageException;
  readonly valid: boolean;
  /** For `covered_elsewhere`: the inventory target the evidence link resolved to. */
  readonly evidenceTargetId?: string;
  readonly problems: readonly (
    | 'rationale_too_short'
    | 'approval_missing'
    | 'expired'
    | 'expiry_beyond_limit'
    | 'evidence_unresolved'
    | 'deferred_on_r3'
    | 'unknown_requirement'
  )[];
}
