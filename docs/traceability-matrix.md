# Traceability Matrix

> **Scope change (2026-10-24).** CI-001 – CI-004, CLI-004, E2E-003, E2E-004, DISC-004 and DISC-005 were removed from scope (AutoTest is not run in CI; GitHub means github.com via `gh`). Rows and criteria that cite them no longer apply; see [task-breakdown.md](task-breakdown.md#phase-2--github-via-gh-githubcom).

This is the canonical home for the links between artifacts. It links:

- goals to requirements
- requirements to components, ADRs, tools and Skill behavior, tasks, verification, and acceptance criteria
- security requirements to threats and mitigations
- release scope to Definition-of-Done gates

The requirement text and IDs themselves live in [product-requirements.md](product-requirements.md). Task details live in [task-breakdown.md](task-breakdown.md).

**Status.** All links are *planned*. A "Verification" cell names the method that will produce evidence. It does not mean the evidence exists yet.

## 1. Goals → requirements

| Goal | Requirements |
|---|---|
| G-01 PR input | FR-001, FR-002, FR-003, FR-004 |
| G-02 Repository inspection | FR-005, FR-006, FR-007 |
| G-03 Existing test discovery | FR-008 |
| G-04 Requirement extraction | FR-009, FR-010, FR-013, FR-016 |
| G-05 Traceable risk-based plan | FR-011, FR-012, FR-014, FR-015 |
| G-06 Independent coverage validation | FR-017, FR-018, FR-019, FR-020, FR-048 |
| G-07 Authorized execution | FR-021, FR-022, FR-023, FR-024, FR-025, FR-026, FR-027, FR-028, FR-029, FR-030, FR-031, FR-032, FR-033, FR-034, FR-035, FR-036 |
| G-08 Evidence | FR-037 |
| G-09 Conservative failure analysis | FR-038, FR-047 |
| G-10 Reports | FR-039, FR-049 |
| G-11 Optional authorized publication | FR-040, FR-041 |
| G-12 Local Mac and CI | FR-042, FR-043, FR-044, NFR-001, NFR-006 |

## 2. Requirements → component → ADR → tool / Skill → tasks → verification → acceptance

"Skill N" refers to step N of the Skill workflow in [agent-skill-spec §3](agent-skill-spec.md#3-workflow-normative-for-the-skill). The acceptance criterion is the summary given in product-requirements.md.

### Functional

| Req | Component(s) | ADR | Tool / Skill | Tasks | Verification | Acceptance (summary) |
|---|---|---|---|---|---|---|
| FR-001 | workflow, policy | — | TL-01; Skill 2 | PLN-001 | Contract tests, E2E-002 | Manual input ≤ 64 KiB gives a valid PRContext |
| FR-002 | github | ADR-0013 | TL-01; Skill 2 | GH-001, GH-002, DISC-005 | Integration against GHES fixtures, E2E-004 | All fields populated, truncation reported |
| FR-003 | policy, workflow | ADR-0014 | TL-01 | POL-002, PLN-001, GH-002 | SEC-001, contract tests | Non-allowlisted repo or mismatched repo is denied |
| FR-004 | github, workflow | ADR-0013 | TL-01 | GH-002 | Integration (API down) | Partial context with limitations |
| FR-005 | inspect, adapters | ADR-0009 | TL-02; Skill 3 | INS-001, FL-001, IOS-002, AND-002, RN-001, APM-001 | Fixture classification tests | Correct framework, with evidence |
| FR-006 | inspect | ADR-0009 | TL-02 | INS-001, FL-001 | Unit tests | `present` requires evidence; otherwise `unknown` |
| FR-007 | adapter-flutter | ADR-0010 | TL-02; Skill 3 | FL-001, DISC-007 | Conflict fixture | Both sources listed, no automatic choice |
| FR-008 | inspect, workspace, adapters | ADR-0009 | TL-03 | INS-002, FL-002, WS-001 | Paging and contract tests, 775-file scale | Counts match, completeness reported |
| FR-009 | planning | ADR-0004 | TL-04; Skill 4 | PLN-002 | Corpus tests | Expected set; agent items tagged |
| FR-010 | planning, core | ADR-0003 | TL-04 | CORE-001, PLN-002 | Property test (stable IDs) | Identical input gives identical IDs |
| FR-011 | planning, contracts | ADR-0004, ADR-0003 | TL-05; Skill 5 | CON-004, PLN-003 | Contract tests | Invalid drafts return pointers; valid drafts are persisted |
| FR-012 | planning | ADR-0009 | TL-05 | PLN-003 | Unit tests | Unresolved targets are flagged, never dropped |
| FR-013 | planning | — | TL-04, TL-05 | PLN-004 | Unit and monotonicity tests | Fixture tiers as documented |
| FR-014 | planning, adapter-sdk | ADR-0009 | TL-05 | PLN-005 | Unit tests | Device-only case on host is `ineligible:platform_unavailable` |
| FR-015 | core, storage | ADR-0005 | TL-05 | CORE-002, PLN-003, STO-003 | Cross-Node hash test, property tests | Same plan gives the same hash on Node 24 and 26; edit gives a new version |
| FR-016 | planning | ADR-0004 | TL-04, TL-05; Skill 4 | PLN-002 | Unit tests | Ambiguities recorded with severity floors |
| FR-017 | coverage-gate | ADR-0005 | TL-06; Skill 6 | COV-001, COV-004 | Gate fixtures, SEC-003 staleness | Correct decision; old hash is stale |
| FR-018 | coverage-gate | ADR-0005 | TL-06 | COV-001 | Positive and negative fixture per rule | Each GB/GR detected |
| FR-019 | coverage-gate, policy | ADR-0005 | TL-06 | COV-001, POL-001 | Config tests | Thresholds configurable; GB/GR-01/GR-07 locked |
| FR-020 | coverage-gate | ADR-0006 | TL-05, TL-06, TL-07 | COV-003 | Unit tests | Expired or unapproved exception gives GB-02 |
| FR-021 | policy, storage, cli | ADR-0006 | TL-07, TL-08; Skill 8; CLI | AUTH-001, AUTH-002, AUTH-004, CLI-001, CI-003, DISC-002, DISC-003 | SEC-003 | Scoped, attributable, expiring, revocable approvals; AL rules enforced |
| FR-022 | policy, execution, exec | ADR-0006 | TL-09 | AUTH-003, RUN-001, RUN-002 | SEC-003, integration | Change between create and dispatch cancels the run |
| FR-023 | execution | ADR-0007 | TL-09; Skill 9 | RUN-001, EXE-003 | Contract test (latency, persisted-before-return) | runId returned ≤ 2 s; row exists |
| FR-024 | execution, storage | ADR-0007 | TL-10, TL-11; Skill 10/11 | RUN-003 | Paging property test | 2,000 results, each exactly once |
| FR-025 | execution, exec | ADR-0007 | TL-12 | EXE-002, RUN-004 | Integration (SIGTERM-ignoring, survivor) | Confirmed cancel or `cancel_pending` |
| FR-026 | exec, execution | ADR-0007 | TL-09 | EXE-002 | Integration (hang fixture) | `timed_out` within timeout + grace |
| FR-027 | execution, exec | ADR-0007 | TL-09 | EXE-004, RUN-001 | Integration | Over-limit run stays queued |
| FR-028 | execution | ADR-0007 | TL-09 | RUN-005 | Flaky fixture | `passed` + `flaky` with 2 attempts |
| FR-029 | execution, storage | ADR-0007 | — | RUN-006, STO-004 | OPS-006 resilience | Reattach or `infra_error(supervisor_lost)`; no foreign signal |
| FR-030 | adapter-flutter, adapter-sdk | ADR-0010 | TL-09, TL-11 | FL-003, FL-004, FL-005, ADP-002, DISC-006, E2E-001 | Corpus tests, E2E-002 | Exact outcome mapping; valid JUnit |
| FR-031 | adapter-android | ADR-0011 | TL-09 | AND-001, AND-002, AND-003, AND-004 | E2E-005 | Unit and instrumented results parsed |
| FR-032 | adapter-ios | ADR-0011 | TL-09 | IOS-001, IOS-002, IOS-003 | E2E-005 | xcresult parsed on the verified Xcode version |
| FR-033 | adapter-react-native | ADR-0011 | TL-09 | RN-001, RN-002, RN-003 | E2E-006 | Jest and Maestro parsed |
| FR-034 | adapter-appium | ADR-0011 | TL-09 | APM-001, APM-002 | E2E-006, gated Autotrader run | Pinned scenario run |
| FR-035 | devices | — | TL-13 | DEV-001 | Parser fixtures, macOS integration | Matches simctl/adb output; unsupported is reported |
| FR-036 | devices, policy | ADR-0006 | TL-14 | DEV-002 | Security tests | Non-owned erase without approval is denied |
| FR-037 | evidence | ADR-0008 | TL-15; Skill 11 | EVD-001, EVD-002, FL-005, CI-004 | SEC-001, integration | Complete metadata; oversize handled |
| FR-038 | analysis | — | TL-16; Skill 12 | ANL-001, ANL-003 | Rule fixtures, property tests (caps) | Expected classes; `product_defect` is a hypothesis unless the criteria are met |
| FR-039 | reporting | — | TL-17; Skill 13 | RPT-001, RPT-002, RPT-003, RPT-004 | Snapshots, E2E-002 | Planned vs. executed shown; a test that did not run is never reported as passed |
| FR-040 | github | ADR-0013 | TL-18; Skill 14 | GH-003, GH-005 | E2E-004 | One comment after republish |
| FR-041 | github | ADR-0013 | TL-18 | GH-004, GH-005 | GHES fixtures (checks disabled) | Fallback works and is reported |
| FR-042 | cli, workflow | ADR-0012 | CLI `ci run` | CI-001, CLI-004, CI-002 | E2E-004 | Same plan hash; never auto-approves |
| FR-043 | cli | ADR-0006 | CLI `approve` | CLI-001 | pty tests, SEC-003 | AL2 after an explicit TTY `y` (default No); non-TTY fails |
| FR-044 | cli | — | CLI `doctor`/`cleanup` | CLI-002, CLI-003, OPS-004 | Integration | Remediations shown; dry-run equals actual |
| FR-045 | core, storage, mcp-server | — | All tools | OBS-002, MCP-002 | Audit-chain tests | Tampering detected |
| FR-046 | skill | — | Skill 1–15 | SKL-001, SKL-002 | Skill evaluation | Forbidden behaviors absent |
| FR-047 | analysis | — | TL-16 | ANL-002 | Integration on git fixture | Baseline failure gives `pre_existing` |
| FR-048 | coverage-gate, adapter-flutter | ADR-0005 | TL-06, TL-17 | COV-002, FL-005 | Metric fixtures | Formulas exact; null handling |
| FR-049 | core, reporting | — | TL-17 | CORE-005, RPT-001 | Verdict-table fixtures, property tests | Every row correct |

### Non-functional

| Req | Component(s) | ADR | Tasks | Verification | Acceptance (summary) |
|---|---|---|---|---|---|
| NFR-001 | repo, CI | ADR-0001 | OPS-001, OPS-002, OPS-005, DISC-001 | Node 24/26 matrix | Green on both |
| NFR-002 | core, planning, coverage-gate | ADR-0005 | CORE-002, PLN-003, COV-001 | Property tests | Deterministic outputs |
| NFR-003 | all | — | OPS-005 | Benchmarks | p95 targets |
| NFR-004 | mcp-server, contracts | ADR-0003 | MCP-002, CON-007, RUN-003 | Contract size assertions | ≤ 20,000 chars |
| NFR-005 | storage, execution | ADR-0007, ADR-0008 | STO-001, STO-004, EXE-003, OPS-006 | Kill-9 tests | No acknowledged loss |
| NFR-006 | exec, CI | ADR-0014 | EXE-001, OPS-002 | Linux CI job; ExecPort review | Linux green; ports used |
| NFR-007 | adapter-sdk, core | ADR-0009, ADR-0015 | ADP-001, OPS-003, CORE-004 | Contract kit, depcruise | New adapter needs no core change |
| NFR-008 | core, apps | — | OBS-001, OBS-003 | Log schema tests | Correlation IDs present |
| NFR-009 | repo | ADR-0015 | OPS-002, OPS-003 | Coverage and boundary CI | Thresholds met |
| NFR-010 | mcp-server | ADR-0001 | DISC-001, MCP-001 | Interop test | Pinned client works |
| NFR-011 | policy, core | — | POL-005, OBS-001 | Redaction tests | Coarsened or hashed |
| NFR-012 | evidence, cli | ADR-0008 | EVD-003, OPS-004 | Retention tests | Defaults enforced |
| NFR-013 | contracts, mcp-server, cli | ADR-0003 | CON-002, MCP-002, CLI-002 | Contract tests | Every error has code, message, recoverable flag and nextSteps |
| NFR-014 | repo | — | OPS-002, REL-002 | Doc-link check, readiness review | Docs updated with behavior |

### Security

| Req | Threats | Mitigation tasks | Verification | Acceptance (summary) |
|---|---|---|---|---|
| SR-001 | T-01, T-03 | CON-007, MCP-002, OPS-003 | No-command-field test, SEC-001 | No tool accepts commands |
| SR-002 | T-03 | POL-003, EXE-001 | SEC-001 | Only allowlisted executables and argument schemas |
| SR-003 | T-04 | POL-002, WS-001 | SEC-001 | Traversal and symlink escapes denied |
| SR-004 | T-05 | POL-004 | SEC-001 (env canary) | No parent-environment leakage |
| SR-005 | T-05 | POL-005, EVD-001, EVD-002 | SEC-001 canaries | Redacted or quarantined |
| SR-006 | T-01, T-20 | MCP-002, POL-001, SEC-002 | SEC-002 | Injection has no effect on decisions |
| SR-007 | T-15 | AUTH-001, AUTH-002, CLI-001, CI-003, DISC-003 | SEC-003 | Agent cannot approve; AL rules enforced |
| SR-008 | T-18 | AUTH-003, RUN-002, EXE-001 | SEC-003 | Independent enforcement at create, dispatch and spawn |
| SR-009 | T-06 | GH-001, GH-005 | SEC-003 (GitHub cases) | No write without P3 |
| SR-010 | T-07, T-09 | EXE-002, EXE-004 | OPS-006, SEC-001 | Limits enforced |
| SR-011 | T-10 | DEV-002 | DEV-002 security tests | Non-owned or physical devices protected |
| SR-012 | T-04, T-07 | EVD-001 | SEC-001 | Artifact validation |
| SR-013 | T-11 | EXE-001, POL-004 | SEC-001 | Per-run isolation |
| SR-014 | T-08 | POL-003, FL-003 | SEC-001 | No network installs by default |
| SR-015 | T-19 | OBS-002 | Audit tests | Tamper detection |
| SR-016 | T-12 | CI-002, CI-003 | E2E-004 fork simulation | No secrets to untrusted code |
| SR-017 | T-13 | MCP-001 | No-listener test | No HTTP in v1.0 |
| SR-018 | T-14 | SEC-005, OPS-002 | Release artifacts | SBOM, provenance, audit |
| SR-019 | T-17 | STO-001, AUTH-001 | Permission tests | 0700/0600 outside repos |
| SR-020 | T-01 | SKL-001, SKL-002 | Skill evaluation | Skill forbids following content |

## 3. Security requirements → threats → mitigations

The threat-centric view is in [security-threat-model §5](security-threat-model.md#5-threats-and-mitigations). Every threat T-01 … T-21 lists its mitigation tasks there.

These threats have no SR of their own:

| Threat | Covered by |
|---|---|
| T-16 PID reuse | FR-029 / FR-025 tasks EXE-001, EXE-002, RUN-006 |
| T-21 handle forgery | MCP-002 |

## 4. Release scope → Definition of Done

| Release | Requirements in scope | DoD gates (in addition to all per-PR gates) |
|---|---|---|
| v0.1 | FR-001, FR-003, FR-005–FR-030 (Flutter host only), FR-037–FR-039, FR-043–FR-046, FR-048, FR-049; NFR-001, NFR-002, NFR-004–NFR-011, NFR-013, NFR-014; SR-001–SR-008, SR-010, SR-012–SR-015, SR-017, SR-019, SR-020 | DOD-REL-01, 02, 03, 04, 08 (E2E-002), 11, 12, 16 |
| v0.2 | v0.1 scope plus FR-002, FR-004, FR-040–FR-042, FR-047; SR-009, SR-016 | v0.1 gates plus DOD-REL-07, 08 (E2E-004; E2E-003 or deferral) |
| v1.0 | v0.2 scope plus NFR-003, NFR-012, SR-018 (hardening) | v0.2 gates plus DOD-REL-05, 06, 09, 10, 13, 14, 15 |
| v1.1 | FR-031, FR-032, FR-035, FR-036, SR-011; Flutter `integration_test` (FR-030 device scope) | All gates plus DOD-REL-08 (E2E-005) |
| v1.2 | FR-033, FR-034 | All gates plus DOD-REL-08 (E2E-006) |

## 5. Requirements intentionally without implementation tasks

None. Every FR, NFR and SR above maps to at least one task. The plan validation confirms this.

Some tasks have no FR/NFR/SR mapping and exist only to enable other work:

| Task | Traces to |
|---|---|
| DISC-* | Decisions and open questions |
| OPS-001 | Scaffold for NFR-001/009 |
| REL-002 | The DoD itself |
| E2E-* | Goal-level validation |

Each of these states its rationale in its `Context` field.

## 6. Semantic spot-checks of important links

Each check confirms that the link is meaningful and not merely present.

| Link | Why it is meaningful |
|---|---|
| FR-017 → COV-001/COV-004 → ADR-0005 | The gate package must not import `planning`. OPS-003 enforces this with the `coverage-gate-not-planning` rule, which is the property ADR-0005 requires. |
| FR-022 → AUTH-003 + RUN-002 + EXE-001 | Authorization is evaluated at create and at dispatch, and re-checked per spawn. Three independent enforcement points match SR-008. |
| FR-021 → CLI-001 (AL2) + DISC-003 (AL3) | RL-008 shows that elicitation alone cannot prove a human acted. The CLI and AL3 tasks are what actually satisfy "agent cannot approve". |
| FR-039 → CORE-005 property test | "Never report a test that did not run as passed" is enforced by a property test, not only by review. |
| FR-030 → DISC-006 | The parser is built against a captured real corpus, not an assumed protocol. |
| SR-016 → CI-002/CI-003 → E2E-004 fork simulation | Fork-PR secret exposure is tested end to end. |
