# Definition of Done

> **Status:** Planned design, baseline of 2026-10-22. Nothing described here is implemented yet.

This document is the canonical home for the per-PR quality gates and the release gates of the Mobile AutoTest MCP codebase.

There are two levels of done:

- **Task-level completion.** A task is done when its own acceptance criteria are met and its verification has been executed. Those criteria are listed in [task-breakdown.md](task-breakdown.md).
- **Release-level done.** A release is done when it passes the gates below.

Writing documentation never completes a task that requires executable verification.

## 1. Per-PR gates (mandatory for every PR to the AutoTest repository)

| ID | Area | Gate | How verified |
|---|---|---|---|
| DOD-PR-01 | Requirements | The PR description cites the task IDs and the FR/NFR/SR IDs it implements. If a canonical definition changed, the canonical doc is updated in the same PR (NFR-014). | PR template checklist and doc-link check (OPS-002) |
| DOD-PR-02 | Requirements | No new behavior without a requirement. A new requirement is added to product-requirements.md and the traceability matrix. | Review |
| DOD-PR-03 | Architecture | dependency-cruiser passes, including `coverage-gate-not-planning`, `only-exec-spawns`, `adapters-no-side-effects` and `sdk-only-in-app` (ADR-0015). | CI (OPS-003) |
| DOD-PR-04 | Architecture | Changed contracts: the Zod schemas, JSON Schema snapshots and doc examples all agree (CON-007). | CI |
| DOD-PR-05 | Architecture | Platform differences are expressed through capabilities, never through `if (platform)` checks in core packages. | Review plus lint rule |
| DOD-PR-06 | Security | No tool input can carry a command, argv, shell or script field (CON-007 test). No new executable or flag is added without updating its policy schema. | CI and review |
| DOD-PR-07 | Security | No default GitHub write permission. Any new write path requires P3 authorization. | SEC-003 suite |
| DOD-PR-08 | Security | Any new file access goes through the path guard (POL-002). Any new artifact type has redaction or quarantine handling. | SEC-001 suite and review |
| DOD-PR-09 | Security | No secrets in the code, fixtures, logs or docs: the secret scan passes, and canaries are fake. | CI secret scan |
| DOD-PR-10 | Security | Any change to authorization, approval or the gate keeps SEC-003 green and adds cases for the new paths. | CI |
| DOD-PR-11 | Testing | Unit, property and contract tests are added or updated. Coverage thresholds (NFR-009) are met for the touched packages. | CI |
| DOD-PR-12 | Testing | Integration tests run for any change to adapters, exec, storage or execution. E2E-002 runs when the workflow, execution or adapters change. | CI path filters |
| DOD-PR-13 | Testing | Security suites SEC-001, SEC-002 and SEC-003 pass. | CI |
| DOD-PR-14 | Operations | New failure modes have an error code, `nextSteps` and a `doctor` check where applicable. | Review |
| DOD-PR-15 | Operations | Any change to the run lifecycle keeps the CORE-003 state-machine docs-sync test green. Timeouts and cancellation are covered by tests. | CI |
| DOD-PR-16 | Skill | Skill changes pass the frontmatter lint and SKL-002 forbidden-behavior checks. | CI and eval |

## 2. Release gates

Release gates are required in addition to every per-PR gate.

| ID | Area | Gate | Applies to | Evidence |
|---|---|---|---|---|
| DOD-REL-01 | Requirements | Every testable acceptance criterion of every requirement in scope for the release is mapped to tests or to a documented exception. Unresolved ambiguities in the product requirements are listed as open questions. | all | Traceability matrix review |
| DOD-REL-02 | Requirements | Every requirement in scope has a passing verification method, or an approved waiver. | all | Traceability matrix + CI evidence |
| DOD-REL-03 | Architecture | `boundaries.json` matches the architecture table (script), and all ADRs in scope are `Accepted (planning)` or later. ADR-0012 must be decided before v0.2. | all | OPS-003 script, ADR index |
| DOD-REL-04 | Architecture | Every tool contract example validates against its schema, and all 18 tools are present. | all | CON-007 |
| DOD-REL-05 | Security | The threat-model review is signed off (SEC-004). No FAIL findings remain. Residual risks are accepted in writing. | v1.0+ | Review doc |
| DOD-REL-06 | Security | Supply chain: an SBOM and provenance are produced, and the audit shows no high or critical findings unless waived (SEC-005). | v1.0+ | Release artifacts |
| DOD-REL-07 | Security | The approval bypass matrix passes (SEC-003, including the CI cases). CI cannot auto-approve. | v0.2+ | Suite report |
| DOD-REL-08 | Testing | The release's E2E suites pass: E2E-002 (v0.1), E2E-004 (v0.2), E2E-005 (v1.1), E2E-006 (v1.2). E2E-003 passes or is formally deferred. | per release | CI logs |
| DOD-REL-09 | Testing | The compatibility matrix passes: Node 24 and 26 × macOS and Linux × the supported Flutter versions (OPS-005). | v1.0+ | Matrix run |
| DOD-REL-10 | Testing | The resilience suite passes (OPS-006). | v1.0+ | Report |
| DOD-REL-11 | Testing | Skill evaluation: forbidden behaviors absent in 100% of runs, required behaviors present in at least 90% (SKL-002). | all | Eval report |
| DOD-REL-12 | Operations | Runs can time out and be cancelled safely. `cancel_pending` is reported honestly, and failed and blocked states can be told apart in reports. | all | E2E and resilience evidence |
| DOD-REL-13 | Operations | Retention and storage policies are enforced (EVD-003). `doctor` and `cleanup` cover the documented failure modes (OPS-004). | v1.0+ | Tests |
| DOD-REL-14 | Operations | Local and CI behavior is documented, and the runbook drills have been executed (OPS-007). | v1.0+ | Drill log |
| DOD-REL-15 | Operations | Performance targets (NFR-003) are met, or have documented exceptions. | v1.0+ | Benchmark report |
| DOD-REL-16 | Docs | README, operations and install docs match the released behavior. Every planned-only feature is labelled as planned. | all | Review |

### Waivers

- A waiver must name the gate, the reason, the risk owner (a role), the expiry, and a follow-up task ID.
- Waivers are recorded in the release readiness document (REL-002).
- No waiver is allowed for DOD-REL-05, DOD-REL-07, DOD-PR-06 or DOD-PR-07.
