# Internal progress record (optional artifact — not a required deliverable)

Workspace: `/Users/smjle/Documents/mobile-autotest-mcp/` · Started 2026-10-22

| Stage | Status | Evidence / notes |
|---|---|---|
| 0 — Preflight | done | Workspace created and write-tested 2026-10-22. Autotrader has no `.git`; the before-snapshot is a SHA-256 manifest of 2,966 files plus a stat listing of 3,900 entries, kept in the session scratchpad (outside both repos). Required manifest fixed at 43 paths (see `docs/plan-validation.md`). |
| A — Research and core architecture | done | Research re-verified directly (official sources), 2026-10-22. |
| A.5 — Consistency checkpoint | done | See the checkpoint section below. |
| B — Contracts | done | 18 tool contracts, coverage policy, adapters, threat model. |
| C — Runtime behavior and Skill | done | Local/CI, observability, testing strategy, Skill + 5 references. |
| D — Delivery planning | done | 130 tasks; DAG acyclic; roadmap phases 0–5. |
| E — Traceability and README | done | |
| F — Validation | done | Runs 1–6; final exit 0 (PASS 47, WARNING 1). Manual review MC-01…MC-20. |
| G — Remediation and final verification | done | Corrections are listed in plan-validation §4–§5. Autotrader before/after identical. Final status COMPLETE_WITH_WARNINGS. |

## Stage A.5 checkpoint (2026-10-22)

I read the requirements, ADRs 0001–0015, the architecture and the data model together. Results:

- **Separation.** Planning (`planning`), the gate (`coverage-gate`, with no planning import), approval (the `policy` verifier plus the `storage` store), authorization (the `policy` evaluator, called by `execution` at create and dispatch, and re-checked by `exec`) and execution are kept apart in the architecture table, ADR-0005 and ADR-0006. PASS.
- **Hash invalidation.** The data model's plan-hash section, the ADR-0005 bindings and the ADR-0006 staleness rules agree. PASS.
- **Run states.** ADR-0007 and the data-model state machine use the same names. `cancel_pending` is non-terminal in both. PASS.
- **Error codes.** The architecture diagrams use codes that must exist in the tool-contracts catalog (Stage B). Carried forward.
- **Finding A5-1.** The mission table references "shared orchestration" without naming a package. Resolved by documenting `packages/workflow` in architecture.md as an elaboration. Needs a task (CORE-006).
- **Finding A5-2.** Phase reorder (hardening → Phase 3) deviates from plan rev3. Rationale: Release 1 must not depend on device platforms. To be recorded in the roadmap and plan-validation.
- **Finding A5-3.** The ADR-0012 link label was mistyped. Fixed.
- **Non-blocking.** The SQLite driver (OQ-19) and the AL3 mechanism (OQ-13) remain open by design.

## Phase 0 (2026-10-23)

| Task | Status |
|---|---|
| DISC-001 | done |
| DISC-002 | done |
| DISC-006 | done |
| DISC-008 | done |
| DISC-003 | partial (needs org signing or FIDO decision) |
| DISC-005 | partial (needs GHES credentials) |
| DISC-007 | blocked (needs Autotrader owners) |
| DISC-004 | not started |

Re-validation run 8: PASS 47, WARNING 1. Autotrader is unchanged.

## Phase 1 (2026-10-23)

OPS-001 and CON-001 – CON-007 are done. `pnpm check` passes on Node 24 and 26 with 109 tests.

OPS-003 and CORE-001 – CORE-006 are done. `pnpm check` (including depcruise and negative fixtures) passes on Node 24 and 26 with 170 tests.

STO-001 – STO-004 and POL-001 – POL-006 are done. `pnpm check` passes on Node 24 and 26 with 286 tests. Line coverage is about 90% for storage and 98% for policy. New runtime dependency: `yaml` 2.9.1 in `@autotest/policy` (zero dependencies, ISC), recorded in RL-037. No git repository yet (not authorized).
Re-validation run 13: PASS 47, WARNING 1. Autotrader is unchanged (2,966-file SHA-256 manifest identical).

AUTH-001 – AUTH-003 are done. `pnpm check` passes on Node 24 and 26 with 349 tests. The plan-hash code moved from core to contracts (`planHash.ts`) because policy may depend only on contracts. The `ApprovalStore` port gained `expireDue`.
Re-validation run 14: PASS 47, WARNING 1. Autotrader is unchanged.

WS-001 and EXE-001 – EXE-004 are done. `pnpm check` passes on Node 24 and 26 with 385 tests. Contract change: cancel reason `resource_quota`. New policy `execution` keys: `maxRunsPerWorkspace`, `maxRunsPerDevice`, `queueCapacity`. Real-process tests ran on macOS only; Linux is not yet verified.
Re-validation run 15: PASS 47, WARNING 1. Autotrader is unchanged.

OBS-001 – OBS-003 are done. Every Phase 1A task is now done except OPS-002 (CI), which waits for a git repository. `pnpm check` passes on Node 24 and 26 with 410 tests. The audit sink now enforces per-kind data rules. The metrics table in the observability doc names its label identifiers (the docs-sync source).
Re-validation run 16: PASS 47, WARNING 1. Autotrader is unchanged.

MCP-001 is done (Phase 1B started). `pnpm check` passes on Node 24 and 26 with 416 tests. Added `@modelcontextprotocol/server` 2.3.1 (with `@modelcontextprotocol/client` 2.3.1 for tests), as planned in ADR-0001.
Re-validation run 17: PASS 47, WARNING 1. Autotrader is unchanged.

MCP-002 is done. `pnpm check` passes on Node 24 and 26 with 436 tests. Fixed a latent SQLite race: `busy_timeout` is now set before `journal_mode`.
Re-validation run 18: PASS 47, WARNING 1. Autotrader is unchanged.

ADP-001 and ADP-002 are done. `pnpm check` passes on Node 24 and 26 with 463 tests. `zod` 4.6.7 is now declared directly in `@autotest/adapter-sdk` (it is already in the lockfile).
Re-validation run 19: PASS 47, WARNING 1. Autotrader is unchanged.

INS-001 and INS-002 are done. `pnpm check` passes on Node 24 and 26 with 483 tests. New ports: `ProfileStore`, `InventoryStore`.
Re-validation run 20: PASS 47, WARNING 1. Autotrader is unchanged.

PLN-001 – PLN-005 are done. `pnpm check` passes on Node 24 and 26 with 524 tests. Added `markdown-it` 15.0.2 to `@autotest/planning` (planned by PLN-002, recorded in RL-037). New port: `PrContextStore`; `RequirementStore.getByHash` takes an optional PR context.
Re-validation run 21: PASS 47, WARNING 1. Autotrader is unchanged.

COV-001 – COV-004 are done. `pnpm check` passes on Node 24 and 26 with 543 tests. Decision reuse now requires an identical gate result as well as identical bindings (ADR-0005 update). Hardened the EXE-002 SIGTERM test: it now waits up to 15 s for the child's trap and fails loudly; one flaky run under full-suite load was traced to the old 2 s wait.
Re-validation run 22: PASS 47, WARNING 1. Autotrader is unchanged.

AUTH-004 and CLI-001 are done. `pnpm check` passes on Node 24 and 26 with 556 tests. `ApprovalRequest` gained a non-digested `display` field (schemas regenerated). `ApprovalStore` gained `findOpenRequest`, `listOpenRequests` and `listRecentApprovals`. `grantApproval` and `serverEnvironmentOf` live in `packages/workflow` so the server and the CLI share them; `WorkflowPorts` moved to `workflow/src/ports.ts` to break an import cycle. Cross-app tests live in the root `test/e2e/` (apps may not import each other). The CLI tests use an injected terminal rather than a pseudo-TTY (no pty library; adding one needs approval).
Re-validation run 23: PASS 47, WARNING 1. Autotrader is unchanged.

2026-10-23 (Phase 1 completion plan, approved): finish Phase 1 and package for macOS/Linux installs from a `.tgz` (esbuild and git init approved).
M0: git initialized (`main`, initial commit), esbuild 0.28.2 added (RL-038), CI workflow written (OPS-002 partial: no remote, never run).
M1: E2E-001 and FL-001 – FL-005 done; the Flutter adapter is built into the server. `pnpm check` passes on Node 24 and 26 with 594 tests. Fixed: the probe parser now tolerates Flutter's first-run banner, and `inspect` no longer reports a version range as resolved.
Re-validation run 24: PASS 47, WARNING 1. Autotrader is unchanged.
M2: RUN-001 – RUN-006 done. `pnpm check` passes on Node 24 and 26 with 613 tests. New `AuthorizationStore` port, optional `PlatformAdapter.prerequisites`, a supervisor entry in the server app (`supervisorBoot.ts` → `supervisorEntry.ts`) wiring the adapters and dispatch-time re-authorization. Fixed during testing: a cancel during supervisor start-up killed it silently; the queue now refreshes slot holders before dispatching. Real Flutter 3.47.1 run of the fixture through `run_tests` completed, with the flaky test passing on attempt 2.
Re-validation run 25: PASS 47, WARNING 1. Autotrader is unchanged.
M3: EVD-001 – EVD-003, ANL-001, ANL-003, RPT-001 – RPT-004 done. `pnpm check` passes on Node 24 and 26 with 648 tests. New ports `AnalysisStore` and `ReportStore`. Evidence is ingested by the supervisor in the collecting state; JUnit rendering lives in workflow (reporting may depend only on core).
Re-validation run 26: PASS 47, WARNING 1. Autotrader is unchanged.
M4: CLI-002 and CLI-003 done. `reconcileRuns` gained `{ pump: false }` so the CLI never starts queued runs. `doctor --suggest-executables` reads SDK versions from `bin/cache/flutter.version.json` and dedupes paths case-insensitively on macOS (found by running it on this machine).
Two EXE-003 supervisor tests were timing-sensitive under full-suite load (a log line read right after terminal.json; an exact SIGTERM-only cancel path). They now wait for the log line and accept SIGKILL escalation. Re-validation run 27: PASS 47, WARNING 1. Autotrader is unchanged.
M5: SKL-001 done; SKL-002 partial (5 scenarios, one run each, all pass; evals/skill/RESULTS.md).
M7: release build (esbuild bundles, guarded bins, SBOM, third-party licenses, npm pack, SHA256SUMS), `autotest setup`/`uninstall-claude`, bundle end-to-end test. SERVER_VERSION and package version are 0.1.0.
M8 (macOS): clean install from the tarball into a temp prefix and HOME; setup registered the server (`claude mcp get autotest`: connected); doctor 0 failures; real Flutter 3.47.1 run through the installed server: pass. Linux NOT VERIFIED: Docker daemon not running (scripts/verify-linux.sh ready).
Incident (2026-10-23, during M7): a shell command whose `cd` into a not-yet-created folder failed wrote a new file `CHANGELOG.md` into the read-only Autotrader root. Found at once by checking its before-snapshot (the file did not exist there); the file was moved out (deletion was blocked as irreversible) and the 2,966-file SHA-256 manifest is identical again. The Autotrader root folder's modification time changed. Writes now always use absolute paths.
Re-validation run 28: PASS 47, WARNING 1. Autotrader manifest identical (after the incident above).
M6: SEC-001 – SEC-003 and E2E-002 done. `pnpm check` passes on Node 24 and 26 with 692 tests. Fixes found by the suites: integrity failures (tampered approval file, tampered plan snapshot) surfaced as E_INTERNAL and now return E_STORAGE_CORRUPT; denial precedence now reports a failed gate before request-shape reasons.
Re-validation run 29: PASS 47, WARNING 1. Autotrader is unchanged.
M8 (final): release tarball rebuilt from the final code (sha256 3ba51f62840650db4f3825a3bb4db0355e2c07c1eb04ea30c5cfcd1438a1bbce); scripts/verify-macos.sh passes on it (temp prefix and HOME, setup, doctor 0 failures, real Flutter 3.47.1 run, report pass, audit chain verified). Linux remains NOT VERIFIED until a Docker daemon is available (scripts/verify-linux.sh).
2026-10-24: remote added by the user; first CI runs: pnpm check green on all four jobs, audit failed on markdown-it 15.0.2 (GHSA-gfr2-rv44-r23c high, GHSA-vfgh-jcmw-g37q low); pinned 15.0.3.
2026-10-24: CI run 39993739919 green on all five jobs (686 passed, 6 skipped per check job; release-build packed on Ubuntu). Remaining for OPS-002: branch protection, doc-link script, Node 24 versions of the actions.
2026-10-24: at the user's request the GitHub repository was made private (it had been public with 0 forks and 0 stars; anonymous access now returns 404). Content pushed while public may already have been seen or cached.
