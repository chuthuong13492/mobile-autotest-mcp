# Implementation Roadmap

> **Status:** Planned design, baseline of 2026-10-22. Nothing described here is implemented yet.

**This document is the canonical source for:** the phase sequence, each phase's objectives, scope, prerequisites and exit criteria, and the criteria for moving on to the next phase. Task details live in [task-breakdown.md](task-breakdown.md). Release designations are defined in [product-requirements §3](product-requirements.md#3-release-designations).

## Phase order and rationale

| Phase | Name | Release |
|---|---|---|
| 0 | Discovery and specification decisions | — |
| 1 | MCP foundation and Flutter host vertical slice | v0.1 |
| 2 | GitHub/GHES and CI | v0.2 |
| 3 | Production hardening and Release 1 | v1.0 |
| 4 | Device-level and native platforms | v1.1 |
| 5 | React Native and optional Appium | v1.2 |

**This differs from the original outline in two ways:**

1. **The original "MCP foundation" and "first end-to-end platform" phases are merged into Phase 1.** The revised specification requires that the first implementation phase focus on Flutter unit and widget tests on the host. A foundation phase without a platform also could not show an executable exit criterion for the full workflow.
2. **Production hardening moves from last place to Phase 3.** Release 1 must not depend on device platforms or device farms. Hardening Release 1 before adding platforms avoids shipping v1.0 without a security review. Each later phase includes its own hardening tasks.

The approved plan (revision 3) listed hardening last. This change is recorded in [plan-validation.md](plan-validation.md) as a deliberate deviation.

## Effort assumptions

- **Team (A-08).** Two experienced TypeScript engineers, with part-time mobile QA and security review. An Apple-silicon Mac is available, and CI capacity exists.
- **Task sizes.** S = 1–2, M = 3–5, L = 6–10 engineer-days. Phase totals below are sums of these ranges. They are **estimates, not measurements**.
- **Calendar time.** Roughly (phase effort ÷ effective parallelism). With two engineers and the lane structure, effective parallelism is about 1.6–1.9. Waiting on external parties is not included: access grants, CI decisions, credential provisioning. Those waits are tracked as risks.
- **Revisit** after Phase 0, using the actual velocity measured during the spikes.

| Phase | Tasks | Effort (eng-days, estimate) | Indicative calendar at 2 engineers |
|---|---|---|---|
| 0 | 8 | 14–25 | 1.5–3 weeks (external access can extend this) |
| 1 | 83 | 218–373 | ≈ 5.5–11 months |
| 2 | 13 | 39–66 | ≈ 1–2 months |
| 3 | 9 | 19–33 | ≈ 2–4 weeks |
| 4 | 11 | 38–64 | ≈ 1–2 months |
| 5 | 6 | 24–40 | ≈ 2.5–5 weeks |

Phase 1 is large because it builds every foundational control: policy, authorization, storage, execution, the gate and the evidence pipeline. Those controls are the bulk of the security and correctness work. Splitting Phase 1 into milestones 1A, 1B and 1C gives earlier checkpoints.

---

## Phase 0 — Discovery and specification decisions

- **Objective.** Resolve the open questions that block architecture or implementation, and prove that the critical external dependencies work.
- **Included scope.**
  - SDK v2 and Claude Code interoperability.
  - Elicitation, hooks and Tasks behavior.
  - AL3 feasibility.
  - CI provider evaluation.
  - GHES capabilities.
  - Flutter JSON corpus.
  - Autotrader access.
  - SQLite driver.
- **Explicit exclusions.** Production code. Spike code is throwaway.
- **Prerequisites.**
  - Access to Claude Code, Node 24/26, Flutter 3.38.x, the GHES sandbox repo and a Mac.
  - Stakeholders identified for the CI decision.
- **Deliverables.**
  - Updated research log.
  - ADR-0001, ADR-0006, ADR-0008 and ADR-0012 updated, with ADR-0012 accepted or kept proposed with a reason.
  - Fixtures: Flutter corpus and GHES recordings.
  - OQ entries closed or re-scoped.
- **Tasks.** DISC-001 … DISC-008.
- **Task dependencies.** DISC-002 depends on DISC-001. DISC-004 depends on DISC-005. All others are independent.
- **Risks.**
  - RK-02: protocol or SDK interop.
  - RK-03: CI cost.
  - RK-06: private dependencies.
- **Verification evidence.**
  - Spike transcripts and recorded outputs.
  - Research-log entries dated within Phase 0.
  - ADR status changes with sign-off.
- **Exit criteria.**
  1. OQ-02, OQ-05 and OQ-19 are closed, meaning the SDK and storage path is confirmed.
  2. The Flutter corpus is committed.
  3. GHES capabilities are recorded.
  4. The ADR-0012 decision is made, or deferred with an explicit plan and a date that does not block Phase 1.
- **Move-on criteria.**
  - Phase 1 may start when exit criteria 1 and 2 are met.
  - Criteria 3 and 4 only block Phase 2.

## Phase 1 — MCP foundation and Flutter host vertical slice (v0.1)

- **Objective.** A local developer can take a manually supplied PR through the complete, secured workflow on a Flutter project's host tests: inspect, extract, plan, gate, approve, authorize, run, evidence, analysis, report.
- **Milestones.**

  | Milestone | Content | Representative tasks |
  |---|---|---|
  | **1A Foundation** | Scaffold, contracts, core, storage, policy, approvals store and verifier, authorization evaluator, workspace, exec, supervisor, observability | OPS-001…003, CON-001…007, CORE-001…006, STO-001…004, POL-001…006, AUTH-001…003, WS-001, EXE-001…004, OBS-001…003 |
  | **1B MCP surface** | Server and middleware, adapter SDK, inspection, planning, gate and approval tools, run tools, CLI approve | MCP-001/002, ADP-001/002, INS-001/002, PLN-001…005, COV-001…004, AUTH-004, RUN-001…006, CLI-001 |
  | **1C Flutter slice and evidence** | Flutter adapter, evidence, analysis, reporting, doctor and cleanup, Skill, fixture, E2E, security suites | FL-001…005, EVD-001…003, ANL-001/003, RPT-001…004, CLI-002/003, SKL-001/002, E2E-001/002, SEC-001…003 |

- **Included scope.** All 18 tools are registered. The tools that need devices return `E_CAPABILITY_UNAVAILABLE` for device actions until v1.1. GitHub-mode `get_pr_context` and publication arrive in Phase 2.
- **Explicit exclusions.**
  - GitHub API.
  - CI mode.
  - Devices.
  - Native, React Native and Appium adapters.
  - Tasks extension.
  - Baseline runs (ANL-002).
- **Prerequisites.** Phase 0 exit criteria 1 and 2.
- **Deliverables.**
  - Packages and apps as listed.
  - The fixture-flutter repository.
  - The Skill.
  - CI for the AutoTest repository.
  - E2E-002 evidence.
- **Task dependencies.** See [task-breakdown.md](task-breakdown.md). The critical path runs DISC-001 → … → E2E-002, 21 tasks.
- **Risks.**
  - RK-01: approval bypass via the agent shell.
  - RK-07: result-format drift.
  - RK-09: scope creep.
  - RK-10: rubber-stamp approvals.
  - RK-12: client output limits.
  - RK-13: prompt injection.
- **Verification evidence.**
  - CI green, covering unit, property, contract, integration and security suites, the boundary rules, and coverage thresholds.
  - E2E-002 run on macOS and Linux, with archived reports.
  - SKL-002 eval report.
- **Exit criteria (v0.1).**
  1. E2E-002 passes on macOS and Linux. All four scenario verdicts are correct.
  2. SEC-001, SEC-002 and SEC-003 pass.
  3. dependency-cruiser rules pass, including `coverage-gate-not-planning`.
  4. Coverage thresholds from NFR-009 are met.
  5. SKL-002 forbidden behaviors are absent in 100% of runs.
  6. Every tool contract example validates (CON-007).
- **Move-on criteria.**
  - Phase 2 may begin as soon as 1B is complete, because GitHub tasks can run in parallel with 1C.
  - Phase 2 cannot *exit* before v0.1 has exited.

## Phase 2 — GitHub/GHES and CI (v0.2)

- **Objective.**
  - Retrieve PRs from GHES.
  - Execute approved plans in CI with AL3 approvals.
  - Publish results to GitHub with least privilege.
- **Included scope.**
  - GH-001…005.
  - CI-001…004 and CLI-004.
  - ANL-002 (baseline runs and the known-failure registry).
  - E2E-003, which is credential-gated.
  - E2E-004.
- **Explicit exclusions.**
  - A second CI provider.
  - Device jobs in CI.
  - Merge gating.
- **Prerequisites.**
  - Phase 0 criteria 3 and 4: GHES capabilities and the CI decision.
  - Phase 1B complete.
  - A sandbox repository.
- **Deliverables.**
  - The GitHub package.
  - CI commands.
  - The reference pipeline for the selected provider.
  - E2E-004 evidence.
  - E2E-003 evidence, or a documented deferral.
- **Task dependencies.** GH-005 needs AUTH-004 and RPT-004. CI-002 needs DISC-004.
- **Risks.**
  - RK-03: CI cost or availability.
  - RK-06: private dependencies.
  - RK-15: GHES gaps.
  - OQ-12: duplication with Claudius.
- **Verification evidence.**
  - Sandbox pipeline run links.
  - Recorded GHES integration tests.
  - The publication audit log.
- **Exit criteria (v0.2).**
  1. E2E-004 passes, including all four of these:
     - `needs_review` without an approval yields `blocked`.
     - Republishing is idempotent.
     - Fork-PR simulation leaks no secrets.
     - The test and publish jobs are separated.
  2. No GitHub write can happen without P3 authorization (SEC-003 extended).
  3. E2E-003 has passed, or has been explicitly deferred with sign-off.
- **Move-on criteria.** Phase 3 may start once E2E-004 passes.

## Phase 3 — Production hardening and Release 1 (v1.0)

- **Objective.** Ship Release 1 with verified security controls, resilience, performance, operations procedures and packaging.
- **Included scope.**
  - SEC-004, SEC-005.
  - OPS-004…007.
  - REL-001, REL-002.
  - MCP-003, conditional on OQ-03.
- **Explicit exclusions.**
  - Device platforms.
  - An OS sandbox (documented as a residual risk).
  - Remote transport.
- **Prerequisites.** Phase 2 exit.
- **Deliverables.**
  - Security review document.
  - Resilience and benchmark reports.
  - Runbook drills.
  - The published package.
  - The v1.0 readiness record.
- **Task dependencies.** REL-002 depends on REL-001, SEC-004, OPS-007, E2E-003, E2E-004 and SKL-002.
- **Risks.**
  - Residual risks that the review cannot accept. This may block the release.
  - Performance shortfalls on large repositories.
- **Verification evidence.**
  - Signed SEC-004 review.
  - OPS-005 and OPS-006 reports.
  - Install log from a fresh machine.
- **Exit criteria (v1.0).**
  1. All release gates in [definition-of-done.md](definition-of-done.md#2-release-gates) are PASS or carry an approved waiver.
  2. No open FAIL finding remains from SEC-004.
  3. NFR-003 benchmarks are met, or have documented exceptions.
- **Move-on criteria.** v1.0 is released. Phase 4 may start, and its spikes (IOS-001, AND-001) may already have run on spare capacity.

## Phase 4 — Device-level and native platforms (v1.1)

- **Objective.** Run Flutter `integration_test`, native Android and native iOS tests on owned simulators and emulators, with device management.
- **Included scope.** DEV-001/002, FL-006, IOS-001…003, AND-001…004 and E2E-005.
- **Explicit exclusions.**
  - Physical devices.
  - Device farms.
  - Device jobs in CI unless DISC-004 selected a macOS provider; in that case they are added under CI-002 follow-ups.
- **Prerequisites.**
  - v1.0 released.
  - macOS hosts with Xcode 26.x.
  - Android SDK.
- **Deliverables.** Native adapters, device tools and E2E-005 evidence.
- **Task dependencies.** IOS-003 and AND-004 require DEV-002.
- **Risks.**
  - RK-07: the xcresult schema.
  - RK-08: simulator state.
  - Emulator flakiness.
- **Verification evidence.** Nightly macOS E2E-005 runs.
- **Exit criteria (v1.1).**
  1. E2E-005 passes on every platform.
  2. Erasing a non-owned device is denied without approval.
  3. OQ-08 and OQ-09 are closed.
- **Move-on criteria.** Phase 5 may start after DEV-002. It exits after v1.1.

## Phase 5 — React Native and optional Appium (v1.2)

- **Objective.** Add RN Jest, Detox and Maestro support, plus the optional Appium adapter with pinned versions.
- **Included scope.** RN-001…003, APM-001/002 and E2E-006.
- **Explicit exclusions.**
  - Device farms such as LambdaTest.
  - Expo-specific runners (evaluate them separately).
- **Prerequisites.**
  - DEV-002.
  - OQ-06 resolved within APM-001.
- **Deliverables.** Adapters and E2E-006 evidence.
- **Task dependencies.** As listed in the task breakdown.
- **Risks.**
  - RK-14: Appium compatibility.
  - Detox native build requirements.
- **Verification evidence.**
  - E2E-006 runs.
  - The APM-002 gated Autotrader scenario run.
- **Exit criteria (v1.2).**
  1. E2E-006 passes.
  2. Version-pin enforcement is tested.
  3. OQ-06 is closed.
- **Move-on criteria.** Further platforms or remote execution need new ADRs, using the extraction criteria in [ADR-0002](architecture-decisions/ADR-0002.md).

## Phase 0 progress (2026-10-23)

**Exit criterion 1 is met.** OQ-02, OQ-05 and OQ-19 are closed:

- SDK v2 works with Claude Code 2.1.169.
- The API surface is recorded.
- The storage driver is `node:sqlite`.

**Exit criterion 2 is met.** The Flutter corpus covers 3.38.4, 3.38.10, 3.41.9 and 3.47.1.

Under the move-on rule, **Phase 1 may start**.

**Still open:**

| Criterion | Status | Gates |
|---|---|---|
| 3: GHES capabilities | Partial: version 3.21.6 and documented features | Phase 2 |
| 4: CI decision | DISC-004 not started | Phase 2 |

DISC-003 (AL3) and DISC-007 (Autotrader access) need organization decisions or access.

## Decisions that must be resolved before implementation starts

| Decision | Needed before | Tracked as |
|---|---|---|
| Whether the SDK v2 stdio server can be used with Claude Code | OPS-001 | OQ-02, OQ-05 (DISC-001). **Resolved 2026-10-23** |
| SQLite driver | STO-002 | OQ-19 (DISC-008). **Resolved: `node:sqlite`** |
| Flutter flags on 3.38.x | POL-003 Flutter schemas, FL-003 | DISC-006. **Resolved** (RL-034) |
| CI provider | CI-002 | OQ-01 (DISC-004) |
| GHES capabilities | GH-004 | OQ-07 (DISC-005) |
| AL3 mechanism | CI-003 (CI path); optional locally | OQ-13 (DISC-003) |
