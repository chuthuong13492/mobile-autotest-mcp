# Observability and Failure Analysis

> **Status:** Baseline of 2026-10-22. Implemented on 2026-10-23: structured logging (§1, OBS-001), run lifecycle events and their import (§2, EXE-003/OBS-003), metrics (§4, OBS-003) and the audit trail (§5, OBS-002). Failure classification (§Failure classification) is still planned.

**Canonical home for:**

- the structured log schema
- run lifecycle events (the supervisor event log)
- the error taxonomy (categories; the codes themselves are in [mcp-tool-contracts §3](mcp-tool-contracts.md#3-error-code-catalog-canonical))
- failure classification rules and evidence criteria
- metrics
- the audit trail

State names come from [data-model-and-artifacts.md](data-model-and-artifacts.md).

## 1. Structured logging

- **Sink.** JSON lines on **stderr** only. The stdio transport owns stdout, and MCP 2026-07-28 deprecates protocol logging ([RL-001](research-log.md#rl-001--current-mcp-specification-revision)). An optional rotating file sink writes to `~/.autotest/logs/`.
- **Schema (`LogRecord`):**

  ```ts
  { ts: string; level: "debug"|"info"|"warn"|"error"; msg: string;          // msg is a constant template, not interpolated user data
    component: string;                                                       // package name
    sessionId?: string; toolCallId?: string; runId?: string; planId?: string; attemptNo?: number;
    code?: ErrorCode; durationMs?: number; data?: Record<string, unknown> }  // data passes the redactor
  ```

- **Rules:**
  1. Every log record passes the redactor before it is written (SR-005).
  2. Untrusted content such as PR text and test names is never logged at `info` or above. At `debug` it is truncated to 200 characters.
  3. Coordinates are coarsened to 1 decimal place, and PII such as emails and phone numbers is hashed (NFR-011).
  4. Correlation: the server creates `sessionId` at process start and `toolCallId` per call. `runId` propagates to the supervisor through its argv. The marker env var is never logged.
- **Levels.** `AUTOTEST_LOG_LEVEL` sets the level, and the default is `info`. Secrets are never logged at any level.

## 2. Run lifecycle events

The supervisor appends records to `runs/<runId>/events.ndjson`, with an fsync per line, before it acts:

```ts
type RunEvent =
  | { t: "state"; ts; from: RunState; to: RunState; reason?: string }
  | { t: "authorization"; ts; phase: "dispatch"; result: "authorized"|"denied"; reasons: string[]; inputsDigest: string }
  | { t: "attempt.start"; ts; attemptNo; specDigests: string[] }
  | { t: "process.start"; ts; pid; pgid; startTime; executable; role: "runner"|"helper"|"appium"|"device" }
  | { t: "process.exit"; ts; pid; exitCode?: number; signal?: string }
  | { t: "attempt.end"; ts; attemptNo; summary: Record<TestOutcome, number> }
  | { t: "cancel"; ts; stage: "term_sent"|"kill_sent"|"confirmed"|"survivors"; survivors?: number[] }
  | { t: "timeout"; ts; scope: "target"|"attempt"|"run" }
  | { t: "evidence"; ts; artifactId; kind; quarantined: boolean }
  | { t: "heartbeat"; ts }                       // also mirrored in heartbeat.json every 5 s
  | { t: "terminal"; ts; state: RunState; infraReason?: string }
```

The server imports the events into SQLite (tracking `runs.events_offset`) during polls and during startup reconciliation. If an events file is malformed or truncated, the last valid line is the source of truth, and the run gets the limitation `event_log_truncated`.

## 3. Error taxonomy

The error codes are the catalog in [mcp-tool-contracts §3](mcp-tool-contracts.md#3-error-code-catalog-canonical). They fall into these categories:

| Category | Codes (prefix match) | Retry by server? | Typical owner |
|---|---|---|---|
| Input | `E_VALIDATION`, `E_INPUT_TOO_LARGE`, `E_CURSOR_INVALID`, `E_IDEMPOTENCY_CONFLICT` | no | agent |
| Not found / lifecycle | `E_NOT_FOUND`, `E_PLAN_NOT_FOUND`, `E_RUN_NOT_FOUND`, `E_RUN_TERMINAL`, `E_REPORT_NOT_READY` | no | agent |
| Policy / authorization | `E_POLICY_*`, `E_WORKSPACE_NOT_ALLOWED`, `E_REPO_MISMATCH`, `E_PATH_ESCAPE`, `E_PLAN_HASH_MISMATCH`, `E_COVERAGE_*`, `E_APPROVAL_*`, `E_ASSURANCE_INSUFFICIENT`, `E_AUTHORIZATION_CHANGED`, `E_DEVICE_NOT_OWNED` | no | human or agent |
| Environment | `E_PREREQUISITE_MISSING`, `E_CAPABILITY_UNAVAILABLE`, `E_UNSUPPORTED_PLATFORM`, `E_DEVICE_UNAVAILABLE`, `E_QUEUE_FULL`, `E_TIMEOUT` | device boot ×1 | human |
| Evidence | `E_ARTIFACT_*`, `E_REDACTION_FAILED` | no | human |
| External | `E_GITHUB_*` | 5xx and 429 with backoff ×5 | human |
| Storage / internal | `E_STORAGE_*`, `E_INTERNAL`, `E_ELICITATION_DECLINED` | storage lock ×3 | maintainer |

**Tool errors are not test outcomes.** A test outcome describes a test, and a tool error describes the tool invocation. A run that hits infrastructure problems reports *run* state `infra_error`. The *tool* call that reads that run still succeeds.

## Failure classification

The classifier is implemented in `packages/analysis`, as `analyze_test_failures` (TL-16). Ruleset `anl-1`.

### Inputs (signals)

1. Normalized results: outcome, `failureKind`, attempts, flaky flag.
2. Adapter `failureSignals` (platform patterns, see the table below).
3. Supervisor events: timeouts, exit signals, cancellations.
4. Traceability: whether the test maps to an AC of a changed requirement, and whether the test file itself was changed in the PR (`changedFiles`).
5. Baseline and registry: a known-failure registry match, or the same test failing in a baseline run on the base ref (FR-047, when available).

### Rules (evaluated in order; one primary class plus alternatives)

| # | Condition | Class / subtype | Strength | Confidence cap |
|---|---|---|---|---|
| A1 | Matches the known-failure registry (not expired) | `pre_existing/known_failure` | supported | 0.9 |
| A2 | Same test failed with the same `failureKind` in a baseline run on the base ref | `pre_existing/baseline_failure` | supported | 0.9 |
| A3 | Environment signals present (table below) and no assertion failure | `environment_failure/<infrastructure\|dependency\|device\|toolchain>` | supported if the signal is unambiguous, otherwise hypothesis | 0.85 |
| A4 | Failed, then passed on retry within the same run (`flaky`) | `test_defect/flaky` (the final outcome is `passed`, recorded for attention) | hypothesis | 0.7 |
| A5 | `failureKind = load_error` and the failing file is a test file changed in the PR | `test_defect/setup` | hypothesis | 0.7 |
| A6 | Setup-phase failure signals (setUp/setUpAll error, missing mock registration, `MissingPluginException` in a widget test) | `test_defect/setup` | hypothesis | 0.7 |
| A7 | Assertion failure in a test whose file was changed in the PR, and the AC mapping is absent or weak | `test_defect/assertion` | hypothesis | 0.6 |
| A8 | Assertion or exception failure in a test mapped to an AC of a requirement in this PR; reproduced on ≥2 attempts, or reproduced in a re-run; no environment signals; not pre-existing (baseline passing or unknown) | `product_defect/behavior` | **supported** only if reproduced **and** the baseline is known to pass; otherwise hypothesis | 0.8 (supported), 0.6 (hypothesis) |
| A9 | Assertion or exception failure that does not match A1–A8 | `product_defect/behavior` as hypothesis, with `test_defect/assertion` as an alternative | hypothesis | 0.5 |
| A10 | `timed_out` / `infra_error` / no signals | `unknown/inconclusive` | — | 0.3 |

### Evidence criteria for `product_defect`

| Strength | Required evidence |
|---|---|
| `hypothesis` (default) | Any assertion or exception failure that the earlier rules do not explain. |
| `supported` | **All** of the following:<br>(1) The failure was reproduced at least twice (2 attempts, or a re-run with the same plan hash).<br>(2) The test maps to an AC of a requirement in the current requirement set.<br>(3) There are no environment signals.<br>(4) A baseline run on the base ref passed, or the registry confirms the test passed before.<br>(5) The relevant artifacts are not quarantined. |
| `confirmed` | **Never emitted automatically.** Only a human can confirm a defect, and that confirmation is outside AutoTest. |

Every analysis lists its `observations` (facts, with artifact references), its `inference` (the reasoning, labelled as such), its `confidence`, its `alternatives`, and its `nextSteps`. Reports render analyses as "likely" or "possible". They never render them as "is".

### Platform signals (initial pattern set; extended per adapter)

| Platform | Pattern (on redacted runner output) | Signal |
|---|---|---|
| Flutter | `done.success == null` / runner exit with no `done` | infrastructure (runner_incomplete) |
| Flutter | `Error: Couldn't resolve the package` / `pub get` required | dependency |
| Flutter | `MissingPluginException` | setup (widget test) / dependency |
| Flutter | `TimeoutException after` | timeout |
| Flutter | SDK version constraint error (`requires SDK version`) | toolchain |
| Android | `INSTALL_FAILED_`, `device offline`, `no connected devices` | device |
| Android | `Could not resolve all dependencies`, `OutOfMemoryError` (Gradle daemon) | dependency / toolchain |
| iOS | `Unable to boot`, `simctl … failed`, `Failed to install` | device |
| iOS | `Code Signing Error`, `No signing certificate` | toolchain |
| iOS | `Test crashed with signal` | none (process crash; the product may be involved) |
| Appium | `ECONNREFUSED 127.0.0.1:<port>`, `Could not find a driver for automationName` | infrastructure / toolchain |
| Any | Exit by SIGKILL after a timeout | timeout |

Patterns are data, defined in `analysis/rules/*.json` with a `rulesetVersion`. Log content can never raise confidence above the rule caps (SEC-002).

## 4. Metrics

Metrics are exposed as counters, histograms and gauges in the stderr JSON (`level: "info", msg: "metric"`) and in the `doctor --stats` summary. A remote metrics backend is out of scope for v1.0. Label values must look like identifiers (`^[A-Za-z0-9_.:-]{1,64}$`); anything else is recorded as `_invalid`, and a metric keeps at most 100 series, with the rest folded into `_overflow` (OBS-003).

| Metric | Type | Labels |
|---|---|---|
| `tool_calls_total` | counter | `tool`, `result` (ok/error code category) |
| `tool_latency_ms` | histogram | `tool` |
| `runs_total` | counter | `state` (terminal state) |
| `run_duration_ms` | histogram | `adapter` |
| `queue_depth` | gauge | — |
| `tests_total` | counter | `outcome`, `adapter` |
| `retries_total` / `flaky_total` | counter | `adapter` |
| `gate_decisions_total` | counter | `decision` |
| `gate_rule_hits_total` | counter | `ruleId` |
| `authorization_denials_total` | counter | `reason` |
| `approvals_total` | counter | `source`, `assurance`, `outcome` |
| `artifacts_quarantined_total` | counter | `reason` |
| `redaction_findings_total` | counter | `class` (rule class; no values) |
| `github_calls_total` | counter | `endpoint` (endpoint class), `status` |
| `cancel_pending_total` | counter | — |
| `reconciliation_actions_total` | counter | `action` (reattach/import/orphan_kill/orphan_unverified, plus storage reconciliation kinds) |
| `storage_bytes` | gauge | `area` |

## 5. Audit trail

- **Format.** `AuditEvent` with hash chaining, as defined in [data-model §AuditEvent](data-model-and-artifacts.md#auditevent). Events are written to `~/.autotest/audit/YYYY-MM.ndjson`. The chain continues across monthly files: each file's first event carries `prevHash` from the previous file.
- **Mandatory events:**
  - `tool.call` / `tool.result`
  - `policy.decision` (with reasons)
  - `authorization.decision` (create and dispatch)
  - `coverage.decision`
  - `approval.requested` / `.created` / `.consumed` / `.revoked` / `.expired` / `.superseded`
  - `plan.versioned`
  - `run.created` / `run.transition`
  - `process.signal` (with identity)
  - `artifact.quarantined`
  - `device.action`
  - `github.write` (mechanism, remote ID)
  - `config.loaded` (policyVersion, gatePolicyVersion, riskPolicyVersion)
  - `reconciliation.action`
- **Verification.** `autotest doctor --audit` recomputes the chain and reports the first broken link. A break produces a `warn` log record and a report limitation `audit_chain_broken` on any report generated afterwards.
- **Privacy.** Audit `data` carries digests and IDs, not raw content. Approver identity is the OS username plus a GitHub login where one has been verified.
- **Enforcement (OBS-002).** Each kind has required `data` keys (`AUDIT_REQUIRED_DATA` in `packages/core/src/auditData.ts`). Strings are at most 256 characters and single-line; nesting and list sizes are bounded. A sink rejects any other event (fail closed). `verifyAuditFiles` checks the chain from the monthly files alone and reports the first broken `file:line`. If the SQLite index is empty, the chain head is recovered from the files.
