/**
 * The adapter contract (ADP-001; ADR-0009; platform-adapters §Adapter interface).
 *
 * Adapters are pure translators between a platform's test tooling and AutoTest's normalized model. They receive
 * ports only — a bounded, policy-checked {@link AdapterWorkspace} and an enumerated {@link ProbePort} — and never
 * spawn processes or touch the filesystem or network (dependency-cruiser rule `adapters-no-side-effects`). They
 * return {@link ExecutionSpec} data; `execution` validates it against policy and `exec` runs it.
 */
import type {
  ArtifactKind,
  DeviceNeed,
  ExecutionSpec,
  FailureClass,
  FailureKind,
  FailureSubtype,
  HostRequirement,
  Limitation,
  Platform,
  PlatformStatus,
  SelectorKind,
  TestCase,
  TestLevel,
  TestOutcome,
  TestTarget,
  ToolchainResolution,
} from '@autotest/core';

/** Bounded, policy-checked read access to one workspace (implemented by `@autotest/workspace`). */
export interface AdapterWorkspace {
  readText(
    rel: string,
    maxBytes?: number,
  ): { readonly text: string; readonly sizeBytes: number; readonly truncated: boolean; readonly binary: boolean };
  exists(rel: string): boolean;
  list(
    globs: readonly string[],
    options?: { readonly maxFiles?: number; readonly exclude?: readonly string[] },
  ): { readonly files: readonly string[]; readonly matched: number; readonly truncated: boolean };
}

/** Enumerated read-only probes, executed by `exec` under the `probe` policy class. */
export type ProbeKind =
  'flutter_version' | 'dart_version' | 'xcode_version' | 'adb_version' | 'node_version' | 'java_version';

export type ProbeResult =
  | { readonly available: true; readonly stdout: string; readonly exitCode: number }
  | { readonly available: false; readonly reason: string };

export interface ProbePort {
  probe(kind: ProbeKind): Promise<ProbeResult>;
}

export interface HostInfo {
  readonly os: 'macos' | 'linux' | 'windows';
}

export interface DetectContext {
  readonly workspace: AdapterWorkspace;
  readonly probes?: ProbePort;
  readonly host: HostInfo;
}

export interface DetectionResult {
  readonly adapterId: string;
  readonly detected: boolean;
  /** 0…1; 0 when not detected. */
  readonly confidence: number;
  /** Workspace-relative paths that support the detection (FR-006: evidence, not guesses). */
  readonly evidence: readonly string[];
  readonly platforms: readonly {
    readonly platform: Platform;
    readonly status: PlatformStatus;
    readonly evidence: readonly string[];
  }[];
  readonly toolchains: readonly ToolchainResolution[];
  readonly runners: readonly {
    readonly kind: string;
    readonly configured: boolean;
    readonly evidence: readonly string[];
  }[];
  readonly limitations: readonly Limitation[];
}

export interface CapabilitySet {
  readonly levels: readonly TestLevel[];
  readonly host: { readonly requires: HostRequirement; readonly available: boolean; readonly reason?: string };
  readonly devices: { readonly needs: DeviceNeed; readonly available: boolean };
  readonly selection: readonly SelectorKind[];
  readonly resultFormats: readonly string[];
  readonly resultGranularity: 'test' | 'file';
  readonly cancellation: 'process_group' | 'graceful_then_group';
  readonly coverage: boolean;
  readonly limitations: readonly string[];
}

export interface InventoryContext extends DetectContext {
  readonly limits: { readonly maxFiles: number; readonly maxReadBytes: number };
}

export interface InventoryFragment {
  readonly adapterId: string;
  readonly targets: readonly TestTarget[];
  readonly helpers: readonly { readonly path: string; readonly kind: 'mock' | 'fixture' | 'helper' | 'config' }[];
  readonly automationConfigs: readonly { readonly path: string; readonly kind: string }[];
  readonly complete: boolean;
  readonly truncatedAt: number | null;
  readonly reasons: readonly string[];
}

export interface ResolveInput {
  readonly testCases: readonly Pick<TestCase, 'id' | 'targetRef' | 'level' | 'platforms'>[];
  readonly targets: readonly TestTarget[];
}

export interface ResolveResult {
  readonly resolved: readonly { readonly testCaseId: string; readonly targetId: string }[];
  readonly unresolved: readonly { readonly testCaseId: string; readonly reason: string }[];
}

export interface ExecutionRequest {
  readonly attemptNo: number;
  readonly targets: readonly TestTarget[];
  /**
   * The device of a device run (FL-006, v1.1): the platform and the id the runner addresses it by — a simulator
   * UDID, or an Android emulator serial (`emulator-<port>`). Absent for host runs.
   */
  readonly device?: { readonly platform: 'ios' | 'android'; readonly id: string };
  readonly options: {
    readonly coverage: boolean;
    readonly timeoutMs: number;
    readonly shard?: { readonly total: number; readonly index: number };
  };
}

/** Runner outputs collected by `execution` for one attempt; contents are already size-bounded and read for the adapter. */
export interface RunnerOutputs {
  readonly attemptNo: number;
  readonly targets: readonly TestTarget[];
  /** Run-dir-relative path → text content (undefined when the file is missing). */
  readonly files: Readonly<Record<string, string | undefined>>;
  readonly processes: readonly { readonly exitCode?: number; readonly signal?: string }[];
  /** True when the supervisor interrupted the attempt (cancel, timeout). Exit codes are never trusted for outcomes. */
  readonly interrupted: boolean;
}

/** A per-test result before persistence (no ids, run or attempt — `execution` adds those). */
export interface NormalizedResult {
  readonly targetId: string;
  readonly name: string;
  readonly suitePath?: string;
  readonly outcome: TestOutcome;
  readonly failureKind?: FailureKind;
  readonly blockedReason?: string;
  readonly durationMs?: number;
  readonly messageExcerpt?: string;
  /** The runner's own status text, for audit and debugging. */
  readonly rawStatus: string;
}

export interface ParseDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface ParseResult {
  readonly results: readonly NormalizedResult[];
  readonly diagnostics: readonly ParseDiagnostic[];
  /** Runner protocol version, recorded in provenance. */
  readonly protocol?: string;
}

export interface EvidenceHint {
  readonly kind: ArtifactKind;
  /** Run-dir-relative path. */
  readonly rel: string;
  readonly mimeType: string;
  readonly required: boolean;
}

export interface FailureSignal {
  readonly targetId?: string;
  readonly resultName?: string;
  /** Stable signal code, e.g. `flutter.missing_plugin`. */
  readonly signal: string;
  readonly indicates: { readonly class: FailureClass; readonly subtype?: FailureSubtype };
  /** Short evidence excerpt (redacted downstream). */
  readonly evidence: string;
}

export interface CleanupContext {
  readonly attemptNo: number;
}

/** Whether a workspace is ready to run (e.g. dependencies resolved); checked before a run is authorized. */
export interface PrerequisiteReport {
  readonly satisfied: boolean;
  readonly missing: readonly { readonly code: string; readonly message: string }[];
}

export interface PlatformAdapter {
  readonly id: string;
  readonly version: string;
  detect(ctx: DetectContext): Promise<DetectionResult>;
  capabilities(ctx: DetectContext): Promise<CapabilitySet>;
  inventory(ctx: InventoryContext): Promise<InventoryFragment>;
  resolveTargets(input: ResolveInput): ResolveResult;
  buildExecution(req: ExecutionRequest): ExecutionSpec[];
  parseResults(outputs: RunnerOutputs): ParseResult;
  evidenceHints(outputs: RunnerOutputs): EvidenceHint[];
  failureSignals(results: readonly NormalizedResult[], outputs: RunnerOutputs): FailureSignal[];
  cleanupSpecs?(ctx: CleanupContext): ExecutionSpec[];
  /** Runtime prerequisites; absent means none beyond the allowlisted executable. */
  prerequisites?(ctx: DetectContext): Promise<PrerequisiteReport>;
  /**
   * ANL-002: how a baseline worktree reuses the workspace's resolved dependencies (runs never resolve them). The
   * listed files are copied from the workspace into the worktree, and only when every lock file is byte-identical
   * at the base commit; otherwise the baseline run is refused. Absent: baseline runs need no dependency state.
   */
  readonly baselineDependencies?: { readonly lockFiles: readonly string[]; readonly copy: readonly string[] };
}
