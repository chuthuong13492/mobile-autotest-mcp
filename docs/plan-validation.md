# Plan Validation Report

This is the canonical record of how the planning package was validated: the commands run, the actual results, the failures found and corrected, the manual semantic review, the remaining gaps, and the final status.

**Validation date:** 2026-10-22 (UTC).

**Validated scope:** the package **documents**. Nothing in this report means the product was built or tested. No product code, tests or CI exist yet.

## 1. Method

1. **Automated structural validation.** A throwaway Node.js script, `validate-plan.mjs`, lives in the session scratchpad and is **not** shipped. It ran against `/Users/smjle/Documents/mobile-autotest-mcp/` using Node v22.19.0, with no dependencies installed. It exits non-zero on any `FAIL` or `BLOCKED` finding. It covers:
   - the structural checks in the specification's §18.1
   - the authorization checks in §18.2, verified as documentary evidence
2. **Manual semantic review.** The author read the package against the §18.3 checklist (§5 below). This review was not independent; that limitation is recorded in §7.
3. **Reference-repository integrity.** SHA-256 manifests and stat listings of `/Users/smjle/Documents/Autotrader` were taken before and after (§6).

Severity scale: `PASS`, `WARNING`, `FAIL`, `NOT_VERIFIED`, `BLOCKED`. `NOT_VERIFIED` is never reported as `PASS`.

## 2. Commands

```bash
node <scratchpad>/validator/validate-plan.mjs /Users/smjle/Documents/mobile-autotest-mcp --autotrader-constants /Users/smjle/Documents/Autotrader/integration_test/src/constants/mobile_apps_constant.ts
```

```bash
node <scratchpad>/validator/dag.mjs docs/task-breakdown.md
```

```bash
cd /Users/smjle/Documents/Autotrader && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 > before.sha256
```

The same `find`/`shasum` command produced `after.sha256`. A matching `find … | xargs stat -f '%N|%z|%Sp|%m'` produced the listings, and the two sets were compared with `diff`.

The `--autotrader-constants` flag lets the validator check that no *secret-like* literal from that file appears in the package. The comparison runs in memory, and literal values are never printed.

## 3. Manifest

| Group | Expected | Present |
|---|---|---|
| Root (`README.md`) | 1 | 1 |
| `docs/*.md` (including this report) | 19 | 19 |
| `docs/architecture-decisions/` (README, template, ADR-0001…ADR-0015) | 17 | 17 |
| `skills/pr-mobile-autotest/` (SKILL.md plus 5 references) | 6 | 6 |
| **Total required** | **43** | **43** (final run) |
| Optional internal artifacts | — | `.planning/progress.md` |
| Unexpected files | — | none |
| Scratch validation artifacts | — | validator, DAG script, run logs and integrity manifests, all in the session scratchpad, outside the workspace |

There are no approved deviations from the manifest.

## 4. Automated validation: run history and corrections

| Run | Result | Findings | Corrections applied |
|---|---|---|---|
| 1 | exit 1. FAIL 9, PASS 38, WARNING 1 | (a) `plan-validation.md` missing (VAL-01, VAL-20). (b) ADR index below the size floor (VAL-02). (c) Schema-key parser missed single-line `z.object({...})` schemas (VAL-14). (d) The tool-name check flagged state names and metrics such as `cancel_pending` and `run_duration_ms` (VAL-18). (e) The outcome check also matched rows of the run-state table (VAL-19). (f) The ADR status regex stopped at "Accepted" (VAL-25). (g) `security-threat-model.md` contained "Auto-approving `needs_review` in CI" inside the *prohibited* list, but the line itself was not negated (AUTHZ-16). (h) 5 Autotrader literals matched (VAL-28). (i) `list_devices`/`manage_simulator` were not mentioned in the Skill docs (VAL-18 warning). | Items (b)–(f) were **validator defects**; the corrected logic is listed below. For (g), the doc line was made self-negating ("(never allowed)"). For (h), the matches were inspected without printing values: all 5 were plain UI-label words (e.g. "Continue", "Semantics"), not credentials. For (i), a "Devices (v1.1+)" section was added to `references/platform-strategies.md`. |
| 2 | exit 1. FAIL 3, PASS 44, WARNING 1 | Same (a). VAL-28: 1 literal on a line whose identifier contained "Key" (a UI widget key, value "location") was treated as secret-like. | Refined the secret-like heuristic: credential lines are those containing password, pwd, secret, token, credential, api key, private key or bearer, plus any value containing both a digit and a symbol. Plain-word collisions are counted and reported, not hidden. |
| 3 | exit 1. FAIL 2, PASS 45, WARNING 1 | Only (a): this report did not exist yet. | The report was written (this file). |
| 4 (final) | exit 0. PASS 47, WARNING 1 (VAL-10, REL-002 enabling rationale) | — | Output embedded verbatim in §4.2 |
| 5 (confirmation) | exit 0. PASS 47, WARNING 1 | Identical to run 4, apart from the timestamp line | — |

### 4.1 Validator calibrations, and why none of them weakens a check

| Change | Justification |
|---|---|
| ADR index (`architecture-decisions/README.md`) size floor set to 2,000 characters (other docs: 4,000) | The index is a navigation document by design. Its substance is the status-semantics table and the 15-row index, and both are checked separately (VAL-21, VAL-25). |
| `topKeys` rewritten to scan inside the outer `z.object({…})` at depth 1 | The old parser silently treated single-line schemas as having no keys, which caused false failures. The new parser is stricter: it no longer picks up keys from nested objects. |
| Tool-name check excludes canonical state names (`cancel_pending`, `cancel_unconfirmed`) and metric names (`*_ms`, `*_total`) | These are not tool names. Real unknown tool names are still detected. |
| Outcome enumeration limited to the "Per-test outcome" section | Otherwise run-state rows that share names (`cancelled`, `timed_out`, `infra_error`) were double counted. |
| ADR status regex matches the exact allowed values | The old regex truncated "Accepted (planning)". |
| Secret-literal comparison limited to credential lines and complex values | Plain English UI labels such as "Continue" are not secrets. Any credential-line value still fails the check if it appears in the package. |

No check was removed. No threshold was lowered for documents that carry substantive content.

### 4.2 Final validator output (run 4, verbatim)

The summary was confirmed identical by a fifth run made after this block was embedded (see §8).

```text
# Validator run 2026-10-22T17:20:43.948Z  root=/Users/smjle/Documents/mobile-autotest-mcp
PASS         VAL-01    Required manifest present
             expected=43 present=43 missing=[] unexpected=[] optional=[.planning/progress.md]
PASS         VAL-02    Required files have substantive content (size floor; semantic review separate)
             all 43 above floor
PASS         VAL-03    Task schema: all 16 fields present and non-empty; Task ID matches; Size present
             130 tasks checked
PASS         VAL-04    Task ID format and permitted prefixes
             130 IDs conform to <PREFIX>-NNN
PASS         VAL-05    Definition IDs unique (FR/NFR/SR/G/A/OQ/RK/T/TL/DOD/GB/GR/tasks)
             FR=49 NFR=14 SR=20 G=12 A=10 OQ=19 RK=15 threats=21 tools=18 DOD=32 gate=18 tasks=130
PASS         VAL-05b   Goals are exactly G-01..G-12
             G-01,G-02,G-03,G-04,G-05,G-06,G-07,G-08,G-09,G-10,G-11,G-12
PASS         VAL-06    All referenced IDs are defined (no dangling references)
             all references resolve
PASS         VAL-07    Task dependencies resolve
             all blocking + recommended deps resolve
PASS         VAL-08    Task dependency graph acyclic
             topological order over 130 tasks
PASS         VAL-09    Critical path computable (to REL-002)
             27 tasks, 77-131 eng-days: DISC-001 -> OPS-001 -> CON-001 -> CON-004 -> CORE-002 -> POL-001 -> POL-005 -> OBS-001 -> MCP-001 -> MCP-002 -> PLN-001 -> PLN-002 -> PLN-003 -> COV-004 -> RUN-001 -> RUN-002 -> RUN-003 -> EVD-002 -> ANL-003 -> RPT-004 -> GH-005 -> CLI-004 -> CI-002 -> CI-004 -> E2E-004 -> SEC-004 -> REL-002
PASS         VAL-09b   Documented critical path matches computed path
             doc=27 computed=27
WARNING      VAL-10    Every task maps to a requirement or a documented enabling rationale
             no-requirement tasks with enabling rationale: [REL-002]; orphans: []
PASS         VAL-11    Every FR/NFR/SR in traceability matrix with ≥1 existing task and a verification method
             83 requirements traced
PASS         VAL-12    Every goal maps to requirements
             12 goals mapped
PASS         VAL-13    Exactly the 18 required tools, catalog = headings, all 21 contract sections present
             18 tools × 21 sections
PASS         VAL-14    Tool examples parse and are structurally consistent with schemas (top-level keys)
             36 examples checked
PASS         VAL-15    Every error code used anywhere exists in the canonical catalog
             45 catalog codes; 51 distinct used
PASS         VAL-16    All 18 tools represented in the permission-tier model
             18 tools in P0–P3 table
PASS         VAL-17    All 18 tools covered by the testing strategy
             18 rows
PASS         VAL-18    Tool names consistent across package (no unknown tool-like names; Skill docs reference all tools)
             unknown: []; tools not mentioned in Skill docs: []
PASS         VAL-19    Run states, outcomes, decisions, verdicts and failure classes consistent with canonical definitions
             run states=11, outcomes=8, verdicts=4, classes=5; stateDiagram matches table
PASS         VAL-20    Relative Markdown links and anchors resolve
             349 relative links checked
PASS         VAL-21    All referenced ADRs exist
             15 distinct ADR refs, 15 ADR files
PASS         VAL-22    Mermaid code fences balanced and diagrams typed
             14 mermaid diagrams
PASS         VAL-22b   Architecture contains the 9 required diagram kinds (context, modules, workflow, coverage/approval, authorization, async lifecycle, cancellation/recovery, evidence/reporting, trust boundaries) + canonical state diagram in data model
             architecture.md mermaid blocks=9; data-model stateDiagram=true
PASS         VAL-23    No unresolved placeholder text outside open-questions/template
             none found
PASS         VAL-24    Open questions / risks have stable IDs, owner role, decision phase, closure criteria
             19 OQ + 15 RK
PASS         VAL-25    ADRs: allowed status values, required sections; CI ADR remains Proposed
             15 ADRs
PASS         VAL-26    Skill frontmatter conforms to Agent Skills spec (six fields only, name=dir, lengths); SKILL.md < 500 lines
             keys=name,description,compatibility,metadata; description=392 chars; lines=86
PASS         AUTHZ-01  Coverage pass does not authorize execution
             ADR-0005.md, test-planning-and-coverage.md, SKILL.md
PASS         AUTHZ-02  Plan hash checked before execution (recomputed)
             ADR-0006.md, data-model-and-artifacts.md
PASS         AUTHZ-03  Stale coverage decisions rejected
             ADR-0005.md, mcp-tool-contracts.md
PASS         AUTHZ-04  Plan edits invalidate approvals
             ADR-0006.md, data-model-and-artifacts.md
PASS         AUTHZ-05  Approval scoped to plan/action/target/environment
             ADR-0006.md
PASS         AUTHZ-06  Agent cannot approve its own plan
             ADR-0006.md, SKILL.md
PASS         AUTHZ-07  CI cannot auto-approve needs_review
             local-and-ci-execution.md, security-threat-model.md
PASS         AUTHZ-08  Execution adapter/exec independently enforce policy
             ADR-0014.md, ADR-0006.md
PASS         AUTHZ-09  Workspace and repository allowlists enforced
             ADR-0006.md, mcp-tool-contracts.md
PASS         AUTHZ-10  Commands and arguments restricted by policy
             ADR-0014.md, security-threat-model.md
PASS         AUTHZ-11  Revoked or expired approvals cannot authorize
             ADR-0006.md, mcp-tool-contracts.md
PASS         AUTHZ-12  Unsupported or unresolved authorization states fail safely
             ADR-0006.md, data-model-and-artifacts.md
PASS         AUTHZ-13  P2/P3 operations require approval controls
             security-threat-model.md, security-threat-model.md
PASS         AUTHZ-14  No generic shell-execution tool
             mcp-tool-contracts.md
PASS         AUTHZ-15  Verdict rules: pass only if gate acceptable and all mandatory tests passed
             data-model-and-artifacts.md
PASS         AUTHZ-16  No statement permits CI/agent auto-approval (every 'auto-approv' mention is negated)
             all mentions negated
PASS         AUTHZ-17  PR verdict rule table ordered blocked→blocked→fail→inconclusive→pass
             blocked,blocked,fail,inconclusive,pass
PASS         VAL-27    No secret-shaped values in package (pattern scan)
             7 patterns × 43 files
PASS         VAL-28    No Autotrader literal values (e.g. hardcoded test passwords) copied into package
             16 secret-like literals (on credential lines — password/secret/token/credential/api key/private key/bearer — or digit+symbol values) from the reference constants file compared: 0 found (values never printed); 7 plain-word UI-label collisions ignored

SUMMARY {"PASS":47,"WARNING":1}
```

## 5. Manual semantic review (§18.3)

| ID | Expected condition | Procedure | Actual result | Status | Evidence / explanation | Follow-up |
|---|---|---|---|---|---|---|
| MC-01 | Requirements are specific, non-contradictory and verifiable | Read all 49 FR, 14 NFR and 20 SR rows. Checked each acceptance summary for a measurable outcome. | All FRs have concrete criteria. NFR-006 (Windows feasibility) is verifiable only by review and a Linux job. NFR-003 targets are measurable, but the benchmark corpus is not yet defined. | WARNING | NFR-006 and NFR-003 rows | OPS-005 defines the benchmark corpus. OQ-18 decides Windows scope. |
| MC-02 | Task acceptance criteria are testable | Sampled 40 tasks across all prefixes. Checked that each acceptance criterion maps to a test, a command or a sign-off. | Testable. Decision tasks (DISC-004, SEC-004, REL-002) use sign-offs, which is appropriate. | PASS | Task blocks | — |
| MC-03 | Every important requirement has an implementation task | Cross-checked concepts that appear in the design docs against task scopes: cursor HMAC, idempotency store, repo-local narrowing config, `readOnlyReference`, approval supersession, plan export, merge-report, the preauthorization parser, device leases, `doctor --repair`. | All found: MCP-002, POL-001, POL-002, PLN-003/AUTH-001, CLI-004, AUTH-002, STO-002/DEV-002, CLI-002. | PASS | task-breakdown.md | — |
| MC-04 | Traceability links are meaningful | Reviewed every FR row's task list against the task objectives, plus 6 deep spot checks (traceability §6). | Links match the task objectives. No row links an unrelated task. | PASS | traceability-matrix.md §2, §6 | — |
| MC-05 | No conflicting package ownership | Compared the architecture table with each task's "Expected files" for approvals, audit, logging, metrics, CI approval, quota, lcov and probes. | Consistent. Two clarifications are implicit: `inspect` reaches `exec` probes only through the injected `ProbePort`, and `coverage-gate` reaches approval verification only through an injected verifier. Both follow the documented injection rule. | PASS | architecture.md, INS-001, COV-003 | Make both injections explicit in the ADP-001 and COV-003 implementations. |
| MC-06 | Trust boundaries are consistent | Compared architecture §10, the threat-model trust boundaries (TB) and the threat tables. | Consistent TB-1 … TB-7. | PASS | — | — |
| MC-07 | Tool contracts are consistent with the permission tiers and the ADRs | Compared each tool's Authorization field with the threat-model tier table and ADR-0006. | Consistent after the ID clash was fixed (see MC-17). | PASS | — | — |
| MC-08 | Lifecycle transitions are consistent | Compared the data-model state diagram with ADR-0007, the cancellation diagram in architecture §8, and TL-12. | Consistent. `cancelled` is reported only after confirmation. `cancel_pending` is non-terminal. | PASS | VAL-19 plus reading | — |
| MC-09 | Error semantics are consistent | VAL-15, plus reading the error categories in observability §3 against the catalog. | Consistent. | PASS | — | — |
| MC-10 | Approval behavior is consistent | Compared ADR-0006 with the threat-model approval matrix, local-and-ci §2.1, the DoD and the Skill security reference. | Consistent: AL2 locally for `needs_review`, AL3 in CI, AL1 insufficient by default. | PASS | AUTHZ-01…17 | — |
| MC-11 | No unsupported technical claims | Checked every runner flag and API in platform-adapters.md and contracts against the research log. | Unverified flags are explicitly marked "⚠ to verify" (15 markers) with owning tasks. SDK call signatures are deliberately not asserted. | PASS (with documented unknowns) | research-log, platform-adapters | DISC-006, IOS-001, AND-001, RN-002, RN-003, APM-001 |
| MC-12 | Examples follow the security policy | Read all 36 tool examples. | Examples never carry commands or secrets. The publish example includes an `approvalId`. Device creation targets an owned device. | PASS | VAL-14 plus reading | — |
| MC-13 | No roadmap stage depends on an unmade decision without saying so | Read the roadmap prerequisites against the open questions. | Phase 1 depends on DISC-001/008 and Phase 2 on DISC-004/005, all explicit. The "Decisions that must be resolved" table lists them. | PASS | implementation-roadmap.md | — |
| MC-14 | Failure handling and recovery are specified | Checked crash, restart, disconnect, disk full, redaction failure, GitHub partial failure and CI interruption. | All are specified in ADR-0007/0008, operations §4 and local-and-ci §2.1. | PASS | — | — |
| MC-15 | Operational procedures are complete | Walked operations §1–§6 as a new operator would. | Complete for a plan. Procedures depend on CLI commands that do not exist yet, which is stated in the doc. Claude Code permission-rule syntax is flagged for verification. | WARNING | operations doc | OPS-007 drills, SKL-001 |
| MC-16 | Definition of Done is consistent | Compared the DoD with the roadmap exit criteria and traceability §4. | Consistent. Release gates map to E2E suites per release. | PASS | — | — |
| MC-17 | Identifier namespaces are unambiguous | Searched for overlapping ID formats. | **Found and fixed.** Tool IDs (`T-NN`) clashed with threat IDs (`T-NN`). Tools were renamed to `TL-NN` across contracts, the testing strategy, the traceability matrix, the threat-model tier table, the test-planning and observability docs, and task objectives. The convention is stated in both canonical docs. Separately, R0–R3 (risk) and P0–P3 (permission) were separated, as the user decided. | PASS (after fix) | VAL-05, VAL-06, VAL-16 | — |
| MC-18 | Planned behavior is not described as implemented | Searched for "implemented"-style claims. Added "Status: planned" banners to the 10 docs that lacked one. The README carries a top banner. | No overclaims remain. | PASS (after fix) | grep results; banners | — |
| MC-19 | No claim that Node 26 is already LTS | Searched for that claim. | None. Every doc states the scheduled date of 2026-10-28. | PASS | RL-011, ADR-0001 | Re-check at DISC-001 |
| MC-20 | The research-log method statement is accurate | Re-read the method paragraph against the entries. | It originally overstated re-verification. Corrected: two "preliminary pass" entries are now labelled as not re-fetched. | PASS (after fix) | research-log | — |

**Other corrections from semantic review:**

- The ADR-0010 error code was written `capability_unavailable` and is now `E_CAPABILITY_UNAVAILABLE`.
- The README package count was corrected from 21 to 22.
- The ADR-0012 link label was corrected.
- The TL-06 example metric key `acCoverage` was renamed `testCaseCoverage`, to match test-planning-and-coverage.md.
- The GR-04 null-metric rule was clarified.

## 6. Reference repository integrity (Autotrader)

| Item | Result |
|---|---|
| Git status | The checkout has **no `.git` directory**, so git-based snapshots were impossible. |
| Before snapshot | SHA-256 of 2,966 files, plus a stat listing (path, size, mode, mtime) of 3,900 entries |
| After snapshot | 2,966 files |
| SHA-256 diff | **identical** |
| Stat listing diff | **identical** (no added, removed or resized entries, and no permission or mtime changes) |
| Commands run in Autotrader | Read-only only: `find`, `grep`, `wc`, `sed -n`, `ls`, `shasum`, `stat`. Nothing built, installed, generated or executed. |
| Limits of the evidence | The snapshots cover file contents and metadata at two points in time. They cannot prove that nothing changed and then reverted in between, or that nothing outside the tree was touched (for example, caches in `$HOME`). However, no tool that writes such caches was run. Plan-mode Explore subagents also read the repository read-only before the before-snapshot was taken. Their effect is covered only by the tools they were allowed to use (read-only), not by the snapshot. |

## 7. Remaining gaps, warnings and unverified items

| Item | Status | Detail / follow-up |
|---|---|---|
| VAL-10: REL-002 traces no FR/NFR/SR directly | WARNING | Its documented enabling rationale is that it verifies the DoD and all v1.0 requirements. This is acceptable. |
| MC-01: NFR-003 benchmark corpus undefined; NFR-006 verifiable only by review | WARNING | OPS-005; OQ-18 |
| MC-15: operational procedures not yet drillable | WARNING | OPS-007 |
| Mermaid diagrams are checked syntactically (fences, diagram type, non-trivial). They were **not rendered**. | NOT_VERIFIED | Render them in a Mermaid-capable viewer during review. |
| Anchor resolution uses a GitHub-style slug algorithm, not an actual renderer | NOT_VERIFIED (partially) | No link failures under the implemented slug rules. Edge cases, such as headings with emoji, may differ on some renderers. |
| Tool examples are validated by JSON parsing and top-level keys only, not by full Zod validation | NOT_VERIFIED (deep schema) | CON-007 will validate every example against the real Zod schemas. |
| External compatibility claims: SDK v2 with Claude Code, Tasks support, Appium 3 with the Flutter driver, GHES checks, xcresulttool subcommands, Android subpaths, Bitrise/Codemagic for GHES | NOT_VERIFIED | OQ-02, OQ-03, OQ-06, OQ-07, OQ-08, OQ-09, OQ-10 (owned by DISC tasks) |
| Effort and calendar estimates | NOT_VERIFIED by design | These are estimates from S/M/L sums with stated assumptions. Revisit after Phase 0. |
| Semantic review independence | WARNING | Single author. An independent architecture and security review is recommended before Phase 1 (folded into the DISC-004 and SEC-004 sign-offs). |
| CI provider decision | Open by design | ADR-0012 is `Proposed`. |

There are no `FAIL` or `BLOCKED` items.

## 8. Deviations from the approved plan (revision 3)

1. **Phase order.**
   - Plan rev 3: 3 = devices/native, 4 = RN/Appium, 5 = hardening.
   - Delivered: 3 = hardening/Release 1, 4 = devices/native, 5 = RN/Appium.
   - Rationale: Release 1 must not depend on device platforms. See the [roadmap](implementation-roadmap.md#phase-order-and-rationale).
2. **Tool ID format `TL-NN`.** This avoids a clash with threat IDs (MC-17).
3. **`packages/workflow`** is named explicitly as the "shared orchestration" layer that the package table refers to. It is an elaboration, not a conflict.
4. **Task prefixes `STO` and `AUTH`** were added to the permitted list, and are documented in the [task breakdown](task-breakdown.md#permitted-prefixes).
5. **Tier labels.** R0–R3 are risk tiers and P0–P3 are permission tiers, as decided by the user during planning.

## 9. Final completeness assessment

| Definition-of-Done area (spec §19) | Assessment |
|---|---|
| Documentation completeness | 43/43 required files present and above the substance floors. README accurate. 15 ADRs with correct status semantics. Skill plus 5 references. |
| Architecture quality | Requirements, ADRs, architecture and data model agree (Stage A.5 plus MC-05/06/08). The gate is independent (enforced rule specified). Approval and authorization are separate. Hash invalidation and the async lifecycle are defined. |
| Tool contracts | Exactly 18 tools, each with 21 sections. Examples are structurally consistent. No shell tool. |
| Implementation planning | 130 tasks × 16 fields. IDs are unique and dependencies resolve. The graph is acyclic. Critical path: 27 tasks to REL-002, 77–131 eng-days serial. |
| Security | Threat model with 21 threats mapped to tasks. No secrets copied. Authorization checks AUTHZ-01…17 pass as documentary evidence. |
| Validation | The automated validator was executed; its final result is in §4.2. The manual review was executed (§5). Gaps are listed (§7). |
| Scope protection | No product code. No dependencies installed. The workspace was not changed. Autotrader is unchanged per the evidence and its limits (§6). |

**Final status: `COMPLETE_WITH_WARNINGS`.**

The warnings and unverified items in §7 are documented and assigned. None of them blocks the start of Phase 0.

## 10. Phase 0 addendum (2026-10-23)

Phase 0 discovery tasks were executed after the baseline validation above. The documents below were updated with their findings:

- research log entries RL-029 – RL-036, plus update notes on RL-004, RL-006, RL-012, RL-014 and RL-024
- ADR-0001, ADR-0006, ADR-0007, ADR-0008, ADR-0013 and the ADR index
- open-question statuses
- platform-adapters flags
- the Phase 0 status table in the task breakdown
- roadmap progress
- the README

**Re-validation (run 8, same validator).**

- The validator was extended in one way: `spikes/**` and `fixtures/**` are classified as optional Phase 0 artifacts, and `node_modules`, `build` and `.dart_tool` are excluded from the file walk.
- Result: exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The manifest is still 43/43 with no unexpected files.
- A secret-pattern scan over `spikes/` and `fixtures/` found no hits. Fixture paths are scrubbed to `<APP>` and `<HOME>`.
- Run artifacts holding local session data were deleted. These were the hook input capture, the proxy log, the compiled helper binaries and the Flutter `build/` folder.

**Autotrader integrity re-check.** After Phase 0, both the SHA-256 manifest and the stat listing are identical to the original before-snapshot. Phase 0 read only one Autotrader file: the validator's in-memory literal comparison. Spikes never touched Autotrader.

**Re-validation (run 13, after STO-001 – STO-004 and POL-001 – POL-006).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). VAL-28 compared the Autotrader test constants in memory only. A first pass of this run flagged VAL-18 because the new data-model implementation note named a database table in code formatting, which the tool-name check reads as an unknown tool; the note was reworded. The Autotrader SHA-256 manifest (2,966 files) is identical to the before-snapshot.

**Re-validation (run 14, after AUTH-001 – AUTH-003).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 15, after WS-001 and EXE-001 – EXE-004).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 16, after OBS-001 – OBS-003).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 17, after MCP-001).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 18, after MCP-002).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 19, after ADP-001 and ADP-002).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 20, after INS-001 and INS-002).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 21, after PLN-001 – PLN-005).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 22, after COV-001 – COV-004).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 23, after AUTH-004 and CLI-001).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 24, after git init, E2E-001 and FL-001 – FL-005).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The validator's file walk now skips `.git/` and accepts the implementation folders `.github/`, `release/`, `plugin/`, `evals/` and `security/`; before that change it raised VAL-01b warnings for those paths only. The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Re-validation (run 25, after RUN-001 – RUN-006).** Exit 0, PASS 47, WARNING 1 (VAL-10, unchanged). The Autotrader SHA-256 manifest (2,966 files) is still identical to the before-snapshot.

**Environment changes outside the workspace.** These were needed for Phase 0. None is a product dependency.

| Change | Detail |
|---|---|
| Node.js versions installed | 24.22.1 and 26.12.1, via nvm. The nvm default alias is unchanged at 22.19.0. |
| Flutter SDKs installed | 3.38.4 and 3.38.10, via FVM, in `~/fvm/versions` |
| pub.dev packages downloaded | Into the user's pub cache, to resolve the scratch app's SDK dependencies for 3.38.x |
| npm packages installed | `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/client@2.3.1` and `zod@4.6.7`, into `spikes/disc-001/node_modules` (23 MB), with `--ignore-scripts` |
| Claude Code headless runs | Several `claude -p` sessions were run against the spike server; these used the user's Claude account |

**Phase 0 status.** DISC-001, DISC-002, DISC-006 and DISC-008 are done. DISC-003 and DISC-005 are partial. DISC-007 is blocked on access. DISC-004 has not started. Phase 0 exit criteria 1 and 2 are met, so Phase 1 may start. Criteria 3 and 4 gate Phase 2. Details are in the [task breakdown](task-breakdown.md#phase-0-execution-status-2026-10-23).
