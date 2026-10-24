# Mobile AutoTest MCP

> **Install (v0.1, macOS/Linux, Node 24+):** `pnpm release:pack`, then on each machine
> `npm install -g ./mobile-autotest-mcp-0.1.0.tgz && autotest setup --workspace <repo> && autotest doctor`.
> See [release/INSTALL.md](release/INSTALL.md).

> **Status: v0.2 — Phase 1 done; Phase 2 (GitHub via `gh`) done.** Phase 2 adds `get_pr_context` GitHub mode and `publish_github_report` (comment upsert, check run with a commit-status fallback, every write approved by a human) on github.com through the user's `gh` login (GH-001 – GH-005). AutoTest does not run inside CI; CI tasks were removed from scope on 2026-10-24. Releases are built by `.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed. Phase 1 history follows. The workspace scaffold (OPS-001), the dependency-boundary enforcement (OPS-003), the contracts (`packages/contracts`: CON-001 – CON-007), the core domain (`packages/core`: CORE-001 – CORE-005), the workflow contract boundary (`packages/workflow`: CORE-006), storage (`packages/storage`: STO-001 – STO-004), the policy primitives (`packages/policy`: POL-001 – POL-006) approvals plus execution authorization (AUTH-001 – AUTH-003), the workspace reader (WS-001) shell-free execution with the run supervisor and queue (EXE-001 – EXE-004), and observability: logging, audit and metrics (OBS-001 – OBS-003) are implemented and tested. Every Phase 1A task is done except OPS-002 (CI), which needs a git repository. Phase 1B has started: the stdio MCP server lists all 18 tools (MCP-001), and every call passes through the tool middleware: audit, idempotency, cursors, output cap and summaries (MCP-002). The adapter SDK, its contract test kit and the JUnit writer are in place (ADP-001/002). `inspect_project` and `inspect_test_inventory` work end to end over the adapter registry (INS-001/002); the Flutter adapter is built in. The planning tools work end to end: `get_pr_context` (manual), `extract_requirements` and `generate_test_plan` (PLN-001 – PLN-005). The independent coverage gate and `validate_test_coverage` are in place (COV-001 – COV-004). `request_approval` and `get_approval_status` work, with optional elicitation that can grant at most AL1 (AUTH-004), and the `autotest` CLI provides `init`, `approve` (TTY challenge, AL2), `revoke` and `approvals` (CLI-001). The Flutter adapter detects Flutter projects, inventories their tests and builds and parses `flutter test` runs (FL-001 – FL-005), checked against real Flutter 3.38–3.47 runs of the fixture app in `fixtures/fixture-flutter` (E2E-001). `run_tests`, `get_run_status`, `get_run_results` and `cancel_test_run` run authorized plans in a detached supervisor with dispatch-time re-authorization, bounded retries with flaky labelling, cancellation and restart reconciliation (RUN-001 – RUN-006). Evidence is validated, redacted and indexed (`collect_test_evidence`, EVD-001 – EVD-003), failures are classified with ruleset anl-1 (`analyze_test_failures`, ANL-001/003), and `generate_pr_test_report` produces the verdict with Markdown, JSON and JUnit reports (RPT-001 – RPT-004). `autotest doctor` diagnoses the installation and `autotest cleanup` reconciles and applies retention (CLI-002/003). Security suites cover command, path, environment, artifact, injection and approval-bypass threats (SEC-001 – SEC-003), and the Phase 1 end-to-end test drives the whole workflow with real Flutter (E2E-002). Each tool answers `E_CAPABILITY_UNAVAILABLE` until its own task lands. Every other capability below is still *planned*. The `spikes/` and `fixtures/` folders contain throwaway Phase 0 experiments and captured test data, not product code. Validation results for this package are in [docs/plan-validation.md](docs/plan-validation.md).

## Purpose

Mobile AutoTest MCP takes a mobile pull request and turns it into a test workflow that is traceable, risk-based, explicitly authorized, executed and backed by evidence.

The system has two parts:

- **An MCP server** (TypeScript) that owns everything deterministic and enforceable.
- **A portable Agent Skill**, `pr-mobile-autotest`, that guides an AI agent through judgment and communication. The first supported client is Claude Code.

Together they:

1. Accept a PR description, or fetch a PR from GitHub (github.com, through `gh`).
2. Inspect the repository and its existing tests.
3. Extract requirements and acceptance criteria.
4. Validate an agent-drafted test plan.
5. Check coverage **independently** of plan generation.
6. Require **human approval** when policy says so.
7. **Authorize** execution separately from coverage.
8. Run tests through controlled, shell-free platform adapters.
9. Collect redacted evidence.
10. Classify failures conservatively.
11. Report a verdict, and publish it to GitHub only when authorized.

## Goals and non-goals

**Goals:** G-01 to G-12 in [product-requirements.md](docs/product-requirements.md#2-goals). In short: PR intake, repository inspection, test discovery, requirement extraction, a traceable plan, independent coverage validation, authorized execution, evidence, conservative failure analysis, reports, optional publication, and support for both local Mac and CI.

**Non-goals for Release 1:**

- A server-side LLM.
- Device farms and device-based execution.
- Remote or multi-tenant deployment.
- Auto-fixing code.
- Merge gating.
- Windows hosts.

## Initial scope

- **v0.1** — Flutter unit and widget tests run on the host, from manual PR input, demonstrated on a public synthetic fixture.
- **v0.2** — Adds GitHub on github.com through `gh`: PR intake and approved publication. (GHES and running AutoTest inside CI were removed from scope on 2026-10-24.)
- **v1.0 (Release 1)** — v0.2 after hardening.
- **Later** — Device-level and native platforms in v1.1; React Native and the optional Appium adapter in v1.2.

The first real target is **Autotrader**, a Flutter app. It is a read-only reference. Running AutoTest against it requires credentials, so it is never a dependency of the basic demo.

## Architecture at a glance

- **A pnpm modular monolith** of 22 packages and 2 apps (`apps/mcp-server`, `apps/cli`). The boundaries are enforced by dependency-cruiser. See [architecture.md](docs/architecture.md#packages-and-dependency-rules).
- **MCP TypeScript SDK v2** over stdio, targeting MCP revision **2026-07-28**. The server is stateless and passes explicit handles between calls. See [ADR-0001](docs/architecture-decisions/ADR-0001.md).
- **Zod 4 contracts** are the single source of truth for all 18 tools ([ADR-0003](docs/architecture-decisions/ADR-0003.md), [tool contracts](docs/mcp-tool-contracts.md)).
- **A filesystem artifact store plus a SQLite index** in `~/.autotest`, kept outside every repository ([ADR-0008](docs/architecture-decisions/ADR-0008.md)).
- **Asynchronous runs** owned by detached per-run supervisors. Runs survive client disconnects and server restarts. Cancellation is verified, and a run reports `cancel_pending` if it cannot be ([ADR-0007](docs/architecture-decisions/ADR-0007.md)).
- **Platform adapters** describe their capabilities and return typed execution specs. Adapters never spawn processes themselves ([ADR-0009](docs/architecture-decisions/ADR-0009.md), [platform-adapters.md](docs/platform-adapters.md)).

## Key design decisions

| Decision | Where |
|---|---|
| The agent drafts the plan. The server validates, normalizes and hashes it. No server-side LLM. | [ADR-0004](docs/architecture-decisions/ADR-0004.md) |
| The coverage gate is a separate package that never imports planning. Its decision is bound to the plan hash, the requirement-set hash and the gate policy version. | [ADR-0005](docs/architecture-decisions/ADR-0005.md) |
| Approval assurance levels: AL1 is elicitation (client-attested), AL2 is an interactive CLI, AL3 is user-presence or an organization review. **Execution authorization is a separate check**, evaluated at run creation and again at dispatch. | [ADR-0006](docs/architecture-decisions/ADR-0006.md) |
| Execution is shell-free and governed by policy, with no generic command tool. | [ADR-0014](docs/architecture-decisions/ADR-0014.md) |
| The first platform is Flutter host tests. Native runners come first, and Appium is used only where it adds value. | [ADR-0010](docs/architecture-decisions/ADR-0010.md), [ADR-0011](docs/architecture-decisions/ADR-0011.md) |
| The CI provider is **not yet decided**. That decision is made in Phase 0. | [ADR-0012](docs/architecture-decisions/ADR-0012.md) (Proposed) |

## Security and execution-authorization model

- **Untrusted content.** PR text, repository files, test names and logs are treated as data, never as instructions.
- **Two separate tier systems:**
  - Permission tiers **P0–P3** classify actions: read-only, local execution, device or environment mutation, and external write.
  - Risk tiers **R0–R3** classify the test-planning risk of a change.
- **Gates before execution.** A coverage `pass` does **not** authorize execution. Authorization also checks the plan hash, approvals, allowlists, the command policy and prerequisites. Anything unknown is denied.
- **Approval rules.** The agent can never approve. CI never auto-approves a plan that needs review. A plan edit invalidates both the coverage decisions and the approvals that were bound to the old hash.
- **Residual risks.** Running tests means running untrusted code, and v1.0 has no OS sandbox. An agent with an unrestricted shell can defeat AL2 approvals. Both are stated in [security-threat-model.md](docs/security-threat-model.md#residual-risks).

## Main workflows

| Workflow | Summary |
|---|---|
| **Local** | Claude Code with the Skill calls the tools, the human approves through `autotest approve` when the plan needs review, and the report is written locally. See [local-and-ci-execution.md](docs/local-and-ci-execution.md). |
| **Publish** | When the user asks, the human approves a `github_publish` scope with `autotest approve`, and `publish_github_report` upserts the PR comment and a check run or commit status. (The CI workflow was removed from scope on 2026-10-24.) |
| **Reviewer** | Reads the PR comment or check. It shows the verdict, planned versus executed tests, limitations and references to evidence. |

## Documentation map and reading order

1. [docs/product-requirements.md](docs/product-requirements.md): goals, requirements, assumptions, glossary.
2. [docs/architecture.md](docs/architecture.md) and [docs/architecture-decisions/](docs/architecture-decisions/README.md): structure and the decisions behind it.
3. [docs/data-model-and-artifacts.md](docs/data-model-and-artifacts.md): entities, states, verdict rules, plan hash, storage.
4. [docs/mcp-tool-contracts.md](docs/mcp-tool-contracts.md): the 18 tools and the error catalog.
5. [docs/test-planning-and-coverage.md](docs/test-planning-and-coverage.md): extraction, the risk model, gate rules, metrics.
6. [docs/platform-adapters.md](docs/platform-adapters.md): Flutter, Android, iOS, React Native, Appium.
7. [docs/security-threat-model.md](docs/security-threat-model.md): threats, permission tiers, approval matrix.
8. [docs/local-and-ci-execution.md](docs/local-and-ci-execution.md): local setup and the CI comparison.
9. [docs/observability-and-failure-analysis.md](docs/observability-and-failure-analysis.md): logs, events, classification.
10. [docs/agent-skill-spec.md](docs/agent-skill-spec.md) and [skills/pr-mobile-autotest/SKILL.md](skills/pr-mobile-autotest/SKILL.md): the Skill.
11. [docs/testing-strategy.md](docs/testing-strategy.md): how this project itself will be tested.
12. [docs/implementation-roadmap.md](docs/implementation-roadmap.md), [docs/task-breakdown.md](docs/task-breakdown.md) and [docs/definition-of-done.md](docs/definition-of-done.md): the delivery plan.
13. [docs/operations-and-troubleshooting.md](docs/operations-and-troubleshooting.md): operating the system.
14. [docs/risks-and-open-questions.md](docs/risks-and-open-questions.md), [docs/research-log.md](docs/research-log.md), [docs/traceability-matrix.md](docs/traceability-matrix.md) and [docs/plan-validation.md](docs/plan-validation.md): evidence and validation.

## Repository structure

All packages are scaffolded. `contracts`, `core` and `workflow` contain real code so far.

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm check
```

These need Node 24 or 26. `pnpm check` runs typecheck, lint, format check, the dependency-boundary rules with their negative fixtures, and the tests.

```
apps/mcp-server  apps/cli
packages/{contracts,core,policy,workspace,exec,adapter-sdk,adapter-flutter,adapter-react-native,
          adapter-ios,adapter-android,adapter-appium,devices,inspect,planning,coverage-gate,
          execution,evidence,analysis,reporting,github,storage,workflow}
skills/pr-mobile-autotest
fixtures/  e2e/  security/  resilience/  docs/
```

## Implementation sequence

| Phase | Content |
|---|---|
| 0 | Discovery and decisions |
| 1 | Foundation and the Flutter host vertical slice (v0.1) |
| 2 | GitHub via `gh` on github.com (v0.2) |
| 3 | Hardening and Release 1 (v1.0) |
| 4 | Device-level and native platforms (v1.1) |
| 5 | React Native and Appium (v1.2) |

The task breakdown has 130 tasks with stable IDs. The critical path to Release 1 runs through 27 tasks. Details are in [docs/implementation-roadmap.md](docs/implementation-roadmap.md).

## Known limitations and open decisions

These are tracked in [docs/risks-and-open-questions.md](docs/risks-and-open-questions.md):

- **OQ-01** — CI provider.
- **OQ-06** — Appium 3 compatibility with the Flutter driver.
- **OQ-07** — GHES capabilities.
- **OQ-08** — `xcresulttool`.
- **OQ-09** — Android result paths.
- **OQ-13** — Local AL3 mechanism.

Phase 0 (2026-10-23) closed OQ-02, OQ-03, OQ-04, OQ-05 and OQ-19. See the Phase 0 status in [docs/task-breakdown.md](docs/task-breakdown.md#phase-0-execution-status-2026-10-23).

## Validation status

See [docs/plan-validation.md](docs/plan-validation.md). It contains the actual automated validator output, the results of the manual semantic review, and the remaining warnings.

Summary as of 2026-10-22:

- **Package status:** `COMPLETE_WITH_WARNINGS`.
- **Automated validator:** 47 PASS, 1 WARNING, 0 FAIL.
- **Manual semantic review:** 20 checks, of which 3 are warnings and the rest pass (several after documented fixes).
- **Autotrader reference repository:** byte-identical before and after.
- **Unverified external compatibility items:** tracked as open questions.
