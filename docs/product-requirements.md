# Product Requirements

**Canonical home for:** goals (G-NN), functional requirements (FR-NNN), non-functional requirements (NFR-NNN), security requirements (SR-NNN), assumptions (A-NN), workflows, scope and glossary.
**Status:** Planning baseline v1, 2026-10-22. Nothing described here is implemented yet.

## 1. Purpose

Mobile AutoTest MCP takes a mobile pull request — a description plus whatever change metadata is available — and produces a test workflow that is traceable, risk-based, explicitly authorized, executed and backed by evidence.

The product has two parts. Each part owns a different set of decisions:

| Part | Owns |
|---|---|
| The Agent Skill `pr-mobile-autotest` | Judgment and interaction |
| The MCP server | Deterministic, enforceable operations |

See [architecture.md](architecture.md) for how the work is split between them.

The system keeps six stages separate and never treats one as standing in for another:

1. Test generation
2. Coverage validation
3. Human approval
4. Execution authorization
5. Test execution
6. Defect classification

## 2. Goals

| ID | Goal |
|---|---|
| G-01 | Accept a PR as a manually supplied description or as a GitHub / GitHub Enterprise Server PR reference. |
| G-02 | Inspect a repository: framework, languages, structure, supported platforms, runners and build configuration, each with evidence and confidence. |
| G-03 | Discover the tests, helpers, fixtures, mocks and automation configuration already in the repository before recommending new tests. |
| G-04 | Extract requirements, acceptance criteria, behavior changes, risks and regression scope from the PR, and flag ambiguity. |
| G-05 | Produce a structured, risk-based test plan in which every requirement traces explicitly to tests. |
| G-06 | Validate coverage independently of plan generation before any execution. |
| G-07 | Execute only authorized, policy-compliant tests through controlled platform adapters. |
| G-08 | Collect logs, reports, screenshots and other evidence with integrity metadata and redaction. |
| G-09 | Analyze failures conservatively. Distinguish product, test, environment, pre-existing and unknown causes without overstating any of them. |
| G-10 | Generate actionable Markdown, JSON and JUnit reports that separate planned work from executed work. |
| G-11 | Optionally publish authorized results to GitHub as PR comments, check runs or commit statuses. |
| G-12 | Run on a developer's Mac and in CI/CD through shared orchestration, with the differences between the two documented. |

## 3. Release designations

These designations are used throughout the docs. Phases are defined in [implementation-roadmap.md](implementation-roadmap.md).

| Designation | Content |
|---|---|
| **v0.1 Local preview** | Phase 1 exit. Manual PR input; Flutter unit and widget tests run on the host; local reports. |
| **v0.2 Integrated preview** | Phase 2 exit. Adds GitHub/GHE PR retrieval, CI mode and authorized publication. |
| **v1.0 Release 1** | Phase 3 exit. The v0.2 scope after production hardening. Release 1 includes **no** device-based execution and **no** device farms. |
| **v1.1** | Phase 4. Flutter `integration_test` on simulators/emulators, native Android, native iOS, and device management. |
| **v1.2** | Phase 5. React Native and the optional Appium adapter. |

## 4. Functional requirements

**Priority** uses MoSCoW: M (must), S (should), C (could) for its release. **Rel** is the earliest release that satisfies the requirement.

| ID | Requirement | Pri | Rel | Acceptance criterion (summary; full criteria in tasks) |
|---|---|---|---|---|
| FR-001 | Accept a manually supplied PR description, with optional title, labels and changed-file list, as a `PRContext` with `source = manual`. | M | v0.1 | A manual input of up to 64 KiB produces a valid `PRContext`. Larger input returns `E_INPUT_TOO_LARGE`. |
| FR-002 | Retrieve a PR from github.com or a GHES instance through a configured `baseUrl`: title, body, labels, base/head refs and SHAs, changed files and diff statistics. | M | v0.2 | Against a recorded GHES fixture, every field is populated. Changed files are paginated up to the API maximum, and truncation is reported. |
| FR-003 | Validate that the requested repository identity (owner/name, or a local path) is on the allowlist and matches the workspace's remote when git metadata exists. | M | v0.1 | A non-allowlisted repo returns `E_WORKSPACE_NOT_ALLOWED`. If the workspace remote differs from the PR repo, the result is `E_REPO_MISMATCH`. |
| FR-004 | When the diff or the GitHub API is unavailable, return a partial `PRContext` that names each limitation explicitly instead of failing silently. | M | v0.2 | With the API simulated as down and a manual fallback supplied, `limitations[]` lists `diff_unavailable` and the plan records that changed-file analysis is missing. |
| FR-005 | Detect frameworks (Flutter, React Native, native iOS, native Android), with a confidence value in 0–1 and the evidence files behind it. | M | v0.1 (Flutter), v1.1/v1.2 (others) | Each fixture repo is classified correctly, and every detection lists at least one evidence path. |
| FR-006 | Report a platform as supported only when there is evidence for it (for example `ios/Runner.xcodeproj` or `android/app/build.gradle*`). Otherwise report `unknown` rather than `unsupported`. | M | v0.1 | A fixture missing `ios/` reports iOS as `absent`. A fixture whose platform folder exists but cannot be parsed reports `unknown`. |
| FR-007 | Resolve toolchain/SDK versions from every known source (pubspec, `.fvmrc`, CI configs, `.tool-versions`) and report conflicts without choosing one silently. | M | v0.1 | On an Autotrader-like fixture, the 3.38.4 vs 3.38.10 conflict appears in `conflicts[]` with both sources. |
| FR-008 | Inventory tests, helpers, fixtures, mocks, integration/UI tests and automation configuration, with completeness indicators and inspection limits. | M | v0.1 | Inventory counts on the fixtures match the ground truth. The `completeness` field reports truncation when limits are hit. |
| FR-009 | Extract requirements deterministically from structured PR sections (checklists, `AC:` blocks, Given/When/Then, headings), and merge agent-supplied requirements, tagging each with its provenance (`parsed` or `agent`). | M | v0.1 | Parsing the extraction fixture corpus yields the expected requirement set. Agent additions are tagged `provenance=agent`. |
| FR-010 | Assign stable requirement IDs (`REQ-NNN`) and acceptance-criterion IDs (`REQ-NNN.AC-NN`) within a requirement set version. | M | v0.1 | Re-running extraction on unchanged input gives identical IDs. |
| FR-011 | Accept an agent-drafted test plan, validate it against the schema, normalize it and assign test-case IDs (`TC-NNN`). | M | v0.1 | Invalid drafts return `E_VALIDATION` with JSON-pointer paths. Valid drafts are persisted. |
| FR-012 | Resolve each test case to an inventory test target (`TT-…`) where possible. Flag unresolved cases as `new_test_required` or `manual`. | M | v0.1 | Cases that reference existing test files resolve. Unknown files are flagged and never silently dropped. |
| FR-013 | Compute a risk tier R0–R3 for each requirement under the documented risk model, record the factor values and the rule that applied, and include the risk policy version. | M | v0.1 | Each risk-model fixture produces the expected tier and rationale. |
| FR-014 | Decide execution eligibility for each test case (`eligible`, `ineligible:<reason>`) from the adapter's capabilities, platform availability and policy. | M | v0.1 | A device-only case on a host-only setup is `ineligible:platform_unavailable`. |
| FR-015 | Compute a deterministic canonical plan hash and persist each plan version immutably. | M | v0.1 | The same normalized plan gives the same hash on Node 24 and Node 26. Any covered-field edit creates a new version with a new hash. |
| FR-016 | Record ambiguities (with severity), assumptions and missing acceptance criteria in the plan. | M | v0.1 | When a vague PR is drafted into a plan, `ambiguities[]` is non-empty and severity is assigned per the taxonomy. |
| FR-017 | Provide an independent coverage gate that evaluates the persisted requirements and plan and returns `pass`, `fail` or `needs_review`, bound to `planHash` and `gatePolicyVersion`. | M | v0.1 | Every gate fixture produces the expected decision. A decision for an old hash is reported as `stale`. |
| FR-018 | The gate must detect uncovered requirements, unjustified or expired exceptions, duplicate tests, weak assertions, missing regression coverage for R2/R3, and platform gaps. | M | v0.1 | Each rule (GB-*/GR-*) has a positive and a negative fixture. |
| FR-019 | Make gate thresholds configurable while mandatory blockers stay non-configurable. | M | v0.1 | Lowering a threshold changes a `needs_review` result. Attempting to disable a GB rule is rejected at config load. |
| FR-020 | Support coverage exceptions, each with a rationale, an approver identity and assurance level, an expiry, and the requirement IDs it applies to. | M | v0.1 | An expired exception produces GB-02 and a gate `fail`. |
| FR-021 | Support approval requests and approval records from three source types (MCP elicitation, the local CLI, a pre-authorization policy file). Each record is scoped, attributable, expiring, revocable and carries an assurance level. | M | v0.1 | Approvals are rejected when their scope, hash or environment differs. Revoked and expired approvals cannot authorize anything. |
| FR-022 | Compute an `ExecutionAuthorizationDecision` before creating a run and re-verify it immediately before dispatch. | M | v0.1 | Changing the plan, the approval or the policy between creation and dispatch produces `E_AUTHORIZATION_CHANGED` and the run is `cancelled` with reason `authorization_invalidated`. |
| FR-023 | `run_tests` persists the run before returning a server-issued `runId`, and returns without waiting for the tests. | M | v0.1 | `run_tests` returns within NFR-003 latency. The run record exists in storage when the response arrives. |
| FR-024 | Provide run status, and per-test results paged by cursor. | M | v0.1 | For a run with 2,000 results, pages of at most `limit` items reproduce every result exactly once. |
| FR-025 | Cancel a run by escalating from SIGTERM through a grace period to SIGKILL. Report `cancel_pending` when termination cannot be confirmed. | M | v0.1 | A fixture test that ignores SIGTERM ends `cancelled` after the grace period. A simulated unkillable child yields `cancel_pending`. |
| FR-026 | Enforce timeouts at three levels: run, attempt and test target. | M | v0.1 | A hanging fixture produces `timed_out` within timeout plus the grace period. |
| FR-027 | Enforce concurrency limits globally, per workspace and per device, with FIFO queueing. | M | v0.1 | A run beyond the limit stays `queued` until a slot frees up. |
| FR-028 | Retry only under a bounded policy: at most N attempts, only for retryable classes, with every attempt recorded. A pass after a failure is labelled `flaky`. | M | v0.1 | The flaky fixture ends `passed` with `flaky=true` and 2 attempts recorded. Deterministic failures are not retried by default. |
| FR-029 | On startup, reconcile incomplete runs and orphaned processes, using a process identity check that defends against PID reuse. | M | v0.1 | If the server is killed mid-run and restarted, the run either reattaches or ends `infra_error` with reason `supervisor_lost`. No foreign process is ever signalled. |
| FR-030 | The Flutter adapter runs unit and widget tests on the host, parses the JSON reporter output, and writes JUnit. | M | v0.1 | Fixture outcomes (pass, fail, error, skip, flaky) map exactly to normalized outcomes. The JUnit output validates. |
| FR-031 | The native Android adapter supports Gradle unit tests and instrumented tests. | S | v1.1 | Fixture app unit and instrumented results are parsed from JUnit XML. |
| FR-032 | The native iOS adapter supports `xcodebuild test` and xcresult parsing. | S | v1.1 | Fixture app results are parsed from the result bundle on the verified Xcode version. |
| FR-033 | The React Native adapter supports Jest unit and component tests, plus Detox or Maestro E2E where configured. | S | v1.2 | The Jest fixture parses. Maestro JUnit parses. |
| FR-034 | The optional Appium adapter works with pinned server and driver versions and supports scenario-based suites. | C | v1.2 | The Autotrader-style scenario fixture runs one scenario with pinned versions. |
| FR-035 | List simulators, emulators and connected devices, with availability and metadata. Distinguish `unavailable` from `unsupported`. | S | v1.1 | Output matches `simctl`/`adb` fixtures. Missing tools are reported as `unsupported_on_host`. |
| FR-036 | Manage simulators and emulators (boot, shutdown, create, erase) with ownership tracking. Destructive or non-owned actions require P2 authorization. | S | v1.1 | Erasing a non-owned simulator without approval returns `E_APPROVAL_REQUIRED`. |
| FR-037 | Collect evidence (runner output, JUnit, JSON, logs, screenshots, coverage). Each artifact records MIME type, size, SHA-256 and provenance, with redaction, size limits and path validation applied. | M | v0.1 | Every artifact in the fixture run carries complete metadata. Oversized artifacts are rejected or truncated per policy, and the decision is recorded. |
| FR-038 | Classify failures as product_defect, test_defect, environment_failure, pre_existing or unknown, with a subtype, observations, evidence references, confidence and alternatives. | M | v0.1 | Each signal fixture gives the expected class. A `product_defect` is emitted only as `hypothesis` unless the evidence criteria are met. |
| FR-039 | Generate Markdown, JSON and JUnit reports that cover PR context, requirements, plan coverage, executed tests, blocked items, failures, evidence references, limitations and the PR verdict. Planned tests must be kept distinct from executed tests. | M | v0.1 | Report snapshots match. A test that was never executed never appears as passed. |
| FR-040 | Publish or update a single PR comment idempotently, using a hidden marker, when authorized. | M | v0.2 | Publishing twice leaves one comment, updated. Retries do not duplicate it. |
| FR-041 | Publish a check run through a GitHub App or Actions token, falling back to a commit status, when authorized. | S | v0.2 | Against a mock GHES that has checks disabled, the fallback to a status works and the report states which mechanism was used. |
| FR-042 | Provide a CLI that executes a committed or approved plan deterministically in CI. | M | v0.2 | `autotest ci run --plan <file>` reproduces the same plan hash and executes it only if authorization succeeds. |
| FR-043 | Provide CLI commands to approve, revoke and list approvals. | M | v0.1 | `autotest approve <hash>` creates an AL2 approval after an interactive confirmation. Running it non-interactively fails. |
| FR-044 | Provide CLI `doctor` (prerequisite diagnostics) and `cleanup` (orphans, retention) commands. | M | v0.1 | `doctor` reports a missing Flutter SDK with a remediation step. `cleanup --dry-run` lists what it would delete. |
| FR-045 | Write an audit event for every tool invocation, policy decision, approval event and external write. | M | v0.1 | An audit chain verification over a fixture session passes. Tampering is detected. |
| FR-046 | Provide the Agent Skill `pr-mobile-autotest`, which guides the full workflow and its stop conditions. | M | v0.1 | Skill evaluation scenarios pass (SKL-002). |
| FR-047 | Maintain a known-failure registry and optional baseline results so that pre-existing failures can be detected. | S | v0.2 | A test that fails on both the baseline and the PR is classified `pre_existing` with the baseline evidence linked. |
| FR-048 | Compute the six coverage metrics and the per-requirement verification status, with the defined formulas. | M | v0.1 | Each metric fixture produces the expected numerator, denominator and value. |
| FR-049 | Compute the PR verdict (`pass`, `fail`, `inconclusive`, `blocked`) under the documented rules. | M | v0.1 | Every verdict-table row in [data-model](data-model-and-artifacts.md#pr-verdict-rules) has a fixture. |

## 5. Non-functional requirements

| ID | Requirement | Measure |
|---|---|---|
| NFR-001 | Runtime support: Node.js 26 is the primary target from its Active LTS date (scheduled 2026-10-28, [RL-011](research-log.md#rl-011--nodejs-release-status)); Node.js 24 is the compatibility target. | CI matrix on both lines. No API used without being available on both, or guarded. |
| NFR-002 | Determinism: the same inputs and policy versions produce the same normalized plan, plan hash, gate decision and verdict. | Property tests over generated plans. Cross-version hash test. |
| NFR-003 | Latency: P0 inspection tools respond in ≤5 s at p95 on a 10k-file repo on an Apple-silicon Mac. `run_tests` returns in ≤2 s at p95. | Benchmark suite (OPS-005). |
| NFR-004 | Output bounds: the default structured response is ≤20,000 characters, which is below Claude Code's 50,000-character persist threshold ([RL-007](research-log.md#rl-007--claude-code-mcp-behaviour-relevant-to-this-design)). Larger data is returned through cursors or artifact references. | Contract tests assert size. |
| NFR-005 | Durability: once acknowledged, run, plan, decision and approval records survive a process crash. No terminal state is lost. | Kill-9 resilience tests (OPS-006). |
| NFR-006 | Portability: macOS (Apple silicon) is primary. The Linux host supports Flutter host tests and CI. Windows feasibility is preserved: the core avoids POSIX-only assumptions behind ports, and process control is abstracted. Windows is not a v1.0 target. | Code review checklist, plus a Linux CI job. |
| NFR-007 | Extensibility: a new platform adapter or CI provider can be added without changing `core`, `planning`, `coverage-gate` or `policy`. | Adapter contract test kit (ADP-001). Dependency rules. |
| NFR-008 | Observability: structured JSON logs on stderr with correlation IDs (`sessionId`, `runId`, `toolCallId`), lifecycle events and metrics. | Log schema tests. |
| NFR-009 | Maintainability: dependency boundaries are enforced in CI. Line coverage is ≥90% for `policy`, `coverage-gate`, `planning` and `core`, and ≥80% elsewhere. | dependency-cruiser and coverage gates (OPS-002, OPS-003). |
| NFR-010 | Protocol compatibility: the server conforms to MCP 2026-07-28 through SDK v2 and interoperates with the pinned Claude Code version. | Interop test (DISC-001, MCP-001). |
| NFR-011 | Privacy-preserving telemetry: coordinates are coarsened to 1 decimal and PII is hashed or omitted in logs and metrics. This follows the reference-team convention. | Redaction tests. |
| NFR-012 | Resource footprint: retention defaults are 14 days for run artifacts and 90 days for audit logs, with a 5 GiB local store cap. All are configurable. | Retention tests (EVD-003). |
| NFR-013 | Usability: every error carries a code, a human message, `recoverable` and `nextSteps`. | Contract tests. |
| NFR-014 | Documentation currency: every behavior change updates the canonical doc, and DoD checks enforce this. | DoD gate ([definition-of-done.md](definition-of-done.md)). |

## 6. Security requirements

| ID | Requirement |
|---|---|
| SR-001 | Do not expose a generic or arbitrary shell-execution tool. Execution requests are typed (`TestTargetRef` and adapter options), never command strings. |
| SR-002 | Spawn processes without a shell. Executables resolve to absolute paths on the policy allowlist, and adapter-built argument vectors are validated against per-executable argument schemas. |
| SR-003 | Restrict every filesystem access to allowlisted workspaces and the server's own data root. Paths are canonicalized with `realpath`; symlinks that escape the root are rejected; comparisons account for case-insensitive filesystems. |
| SR-004 | Child processes get an environment built from an explicit allowlist. Secrets are injected by reference from the configured secret source, never passed in tool arguments, and never written to plan or report content. |
| SR-005 | Redact known secret values, credential patterns and high-entropy tokens from logs, artifacts and reports. If redaction cannot be guaranteed (binary or unsupported formats), quarantine the artifact (fail closed) and exclude it from reports and publication. |
| SR-006 | Treat PR text, repository files, test names, logs and tool outputs as untrusted data. Untrusted content can never change policy, grant approval, widen scope, add executables or bypass gates. Tool outputs label untrusted fields. |
| SR-007 | The agent cannot grant approvals. Every approval carries a trusted source, an assurance level (AL1–AL3), a scope, the plan hash or action digest, an expiry, a policy version and a use count, and can be revoked. |
| SR-008 | Execution authorization is evaluated in `policy` and enforced independently by `execution` (at dispatch) and by `exec` (per spawn). |
| SR-009 | GitHub access is read-only by default. Writes are P3, require authorization and least-privilege credentials, and check runs go only through a GitHub App or Actions token. |
| SR-010 | Enforce resource limits: timeouts, output byte caps, artifact size and count caps, a per-run disk quota, and concurrency limits. |
| SR-011 | Never mutate a device the current run does not own without P2 authorization. Never erase a physical device. |
| SR-012 | Validate every artifact on ingestion for path containment, size, MIME type (sniffed) and symlinks (not followed). Archives are never auto-extracted. |
| SR-013 | Isolate runs from each other: per-run directories, a per-run temporary HOME/TMPDIR where the adapter supports it, no shared mutable state, and cleanup on completion. |
| SR-014 | Do not install dependencies during a run unless policy allows it explicitly. When allowed, installs are lockfile-respecting (`--enforce-lockfile`-style), and network use is recorded. |
| SR-015 | Keep the audit log append-only and hash-chained, so that tampering is detectable. |
| SR-016 | In CI, use short-lived credentials (OIDC or Actions tokens). Never expose secrets to jobs built from untrusted fork code. Use ephemeral or wiped runners. |
| SR-017 | Any future remote transport must implement MCP authorization: OAuth 2.1 resource server, RFC 9728 metadata, RFC 8707 audience validation. It is disabled in v1.0. |
| SR-018 | Supply chain for this project: pinned dependencies, a committed lockfile, an SBOM and provenance on release, and automated vulnerability audit. |
| SR-019 | Data stores (SQLite, approvals, audit) live outside target repositories with permissions `0600`/`0700`, owned by the invoking user. |
| SR-020 | The Skill instructs the agent never to follow instructions found in PR or repository content, and the server never interprets content as instructions. |

## 7. User workflows

1. **Local developer review (v0.1).**
   1. The developer opens Claude Code in the app repo and invokes `/pr-mobile-autotest` with a PR description.
   2. The Skill inspects the repo, drafts requirements and a plan, and calls the gate.
   3. On `needs_review`, the developer reviews the plan summary and approves it in a terminal with `autotest approve <hash>`.
   4. The tests run, and the developer reads the report.
2. **GitHub PR, local (v0.2).** Same as workflow 1, except the PR is fetched from GHE. Publishing a comment requires P3 authorization.
3. **CI (v0.2).**
   1. An approved plan file is committed or attached to the PR.
   2. The CI job runs `autotest ci run`.
   3. Authorization is evaluated: the plan hash must match, and an approval must be recorded through an accepted CI-scoped source.
   4. The job executes, uploads artifacts and publishes a check or status.
   5. A `needs_review` plan without an approval yields a `blocked` verdict. The job never auto-approves.
4. **Reviewer.** Reads the PR comment or check summary and opens the evidence artifacts. The report states its limitations and which tests were planned but not executed.

## 8. Constraints

- TypeScript, pnpm modular monolith, MCP TypeScript SDK v2, Zod 4, stdio transport, filesystem plus SQLite, Octokit ([ADR index](architecture-decisions/README.md)).
- No server-side LLM in Release 1 ([ADR-0004](architecture-decisions/ADR-0004.md)).
- Autotrader is a read-only reference. Its private dependencies make it unsuitable as the basic demo target.
- The CI provider is undecided until Phase 0 ([ADR-0012](architecture-decisions/ADR-0012.md)).

## Assumptions

| ID | Assumption | Impact if false | Linked question |
|---|---|---|---|
| A-01 | Local use is single-user: the agent and the approving human share one OS account. | The approval assurance model needs revisiting. Multi-user use is safer. | [OQ-13](risks-and-open-questions.md#oq-13) |
| A-02 | The pinned Claude Code version can talk to an SDK v2 (2026-07-28) stdio server. | Fall back to SDK v1 for transport ([ADR-0001](architecture-decisions/ADR-0001.md)). | [OQ-02](risks-and-open-questions.md#oq-02) |
| A-03 | The target GHES version exposes the Checks API and supports GitHub Apps. | Fall back to commit statuses only. | [OQ-07](risks-and-open-questions.md#oq-07) |
| A-04 | Developers install platform SDKs (Flutter, Xcode, Android SDK) themselves. AutoTest detects them and does not install them. | `doctor` scope grows. | — |
| A-05 | Workspaces may lack git metadata (the Autotrader checkout has none). Changed-file data then comes from GitHub or manual input. | Baseline runs (FR-047) are unavailable without git. | [OQ-16](risks-and-open-questions.md#oq-16) |
| A-06 | The GitHub API is reachable over the network from developer machines and CI. | GitHub mode is unavailable, and only manual mode works. | — |
| A-07 | Exactly one CI provider is implemented first, chosen in Phase 0. | Phase 2 scope grows. | [OQ-01](risks-and-open-questions.md#oq-01) |
| A-08 | Effort estimates assume 2 experienced TypeScript engineers with part-time mobile-QA support and access to an Apple-silicon Mac. | Estimates scale. | — |
| A-09 | Test targets in v0.1 are files or named tests within a Flutter package. Monorepos with several Flutter packages are detected but may need explicit package selection. | Inventory UX. | — |
| A-10 | The approval store and the user config live under the user's home directory (`~/.autotest/`), outside any target repo. | Path-policy adjustments. | — |

## 9. Out of scope (Release 1)

- Server-side LLM plan generation, and MCP Sampling, which is deprecated in 2026-07-28 ([RL-001](research-log.md#rl-001--current-mcp-specification-revision)).
- Device farms (LambdaTest, BrowserStack, Firebase Test Lab), and device-based execution of any kind before v1.1.
- Remote or multi-tenant MCP deployment (Streamable HTTP). This is a documented extension point (SR-017).
- Auto-fixing tests or product code. Generating new test source files (the plan may *recommend* new tests).
- Windows hosts (feasibility preserved, NFR-006).
- Merge gating that blocks PRs automatically. Reports *recommend* a disposition; branch-protection integration is an org decision.
- Replacing Claudius (code review) or Marionette MCP (live app control) ([OQ-11](risks-and-open-questions.md#oq-11), [OQ-12](risks-and-open-questions.md#oq-12)).

## 10. Glossary

| Term | Definition |
|---|---|
| Acceptance criterion (AC) | A verifiable condition attached to a requirement, with ID `REQ-NNN.AC-NN`. |
| Approval | A recorded human decision that authorizes one scope, from a trusted source, with an assurance level. Distinct from authorization. |
| Assurance level (AL1–AL3) | How strongly an approval source shows that a human acted. AL1 is client-attested, AL2 is local out-of-band interactive, AL3 is cryptographic user presence or an org-controlled review. See [ADR-0006](architecture-decisions/ADR-0006.md). |
| Coverage decision | The gate's output (`pass`, `fail`, `needs_review`), bound to a plan hash and gate policy version. |
| Execution authorization | A per-run decision computed from plan, decision, approvals, allowlists and policy, and re-checked at dispatch. |
| Evidence artifact | A stored file with integrity and provenance metadata. |
| Mandatory test | A test case with priority `must`, or one covering an R2/R3 requirement. |
| Permission tier (P0–P3) | The tool or action side-effect class: read-only, local execution, device/environment mutation, external write. |
| Plan hash | SHA-256 over the RFC 8785 canonical JSON of the hash-covered plan fields. |
| Risk tier (R0–R3) | The test-planning risk class of a requirement or change. R3 is the highest. |
| Run supervisor | The detached per-run process that owns the test child processes and writes the run event log. |
| Test target (TT) | An executable unit known to an adapter, for example a file, a named test or a scheme. |
| Untrusted content | Any data from PRs, repos, logs or tools. It is never interpreted as instructions. |
