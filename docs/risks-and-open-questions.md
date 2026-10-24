# Risks and Open Questions

This document is the canonical home for open questions (OQ-NN) and project risks (RK-NN). Assumptions (A-NN) are recorded in [product-requirements.md](product-requirements.md#assumptions). Threats (T-NN) are recorded in [security-threat-model.md](security-threat-model.md).

**Status:** baseline of 2026-10-22. All items are open unless marked otherwise.

## Open questions

### OQ-01
- **Closed (2026-10-24):** AutoTest is not run in CI; no provider is needed (ADR-0012 withdrawn).
- **Question.** Which CI provider will run AutoTest in CI for v0.2/v1.0, and which provider will run macOS work in v1.1?
- **Impact.** Phase 2 (CI-002/004) and the CI parts of Phase 4. Without a decision, CI E2E-004 cannot run.
- **Current position.** ADR-0012 is `Proposed`. The provisional recommendation is GitHub Actions on GHES with ephemeral self-hosted Linux runners. For macOS, the choice is between Bitrise and self-hosted Macs.
- **Owner (role).** Principal Architect, with the DevSecOps Engineer and the Mobile Platform owner.
- **Decision phase.** End of Phase 0 (DISC-004).
- **Closure criteria.** The scoring sheet is complete with evidence, ADR-0012 is accepted or superseded, and the deciders have signed off.

### OQ-02
- **Question.** Does the pinned Claude Code client work with an SDK v2 (MCP 2026-07-28) stdio server? Which protocol revision does it negotiate?
- **Impact.** ADR-0001. If the answer is no, the transport falls back to SDK v1. This blocks OPS-001.
- **Owner (role).** MCP Engineer.
- **Decision phase.** Phase 0 (DISC-001).
- **Closure criteria.** The spike transcript is recorded, RL-006 is updated, and ADR-0001 is confirmed or amended.
- **Status.** **Closed 2026-10-23** (DISC-001). Claude Code 2.1.169 negotiates `2025-11-25` through `initialize`, and SDK v2 serves it ([RL-030](research-log.md#rl-030--claude-code-21169-interoperability)).

### OQ-03
- **Question.** Does Claude Code support the `io.modelcontextprotocol/tasks` extension?
- **Impact.** It decides whether MCP-003 is implemented. It does not block v1.0.
- **Owner (role).** MCP Engineer.
- **Decision phase.** Phase 0 (DISC-002). Re-check in Phase 3.
- **Closure criteria.** Support is documented as yes or no, with the client version.
- **Status.** **Answered 2026-10-23: not supported** by Claude Code 2.1.169 ([RL-032](research-log.md#rl-032--tasks-extension-in-claude-code)). Re-check on client upgrades.

### OQ-04
- **Question.** How does Claude Code's elicitation behave in practice, and which approval scopes, if any, should policy allow at AL1, given that the `Elicitation` hook can answer automatically?
- **Impact.** The AL1 policy defaults (ADR-0006), and the UX of AUTH-004.
- **Owner (role).** Security Engineer.
- **Decision phase.** Phase 0 (DISC-002).
- **Closure criteria.** The behavior is documented and the default AL1 scope list is confirmed. That list is expected to be empty for gated actions.
- **Status.** **Closed 2026-10-23** (DISC-002).
  - In headless mode, elicitation is auto-cancelled.
  - An `Elicitation` hook auto-accepts with no human ([RL-031](research-log.md#rl-031--an-elicitation-hook-can-approve-without-a-human-empirical)).
  - The default AL1 scope list stays empty.
  - An interactive-dialog check by a human is optional and has not been performed.

### OQ-05
- **Question.** What are the exact SDK v2 APIs: `registerTool` options, how `outputSchema` is derived from Zod 4, the error helpers, and the `_meta` passthrough?
- **Impact.** MCP-001 and MCP-002 implementation details. The contracts themselves are SDK-agnostic.
- **Owner (role).** MCP Engineer.
- **Decision phase.** Phase 0 (DISC-001).
- **Closure criteria.** API notes are added to the research log.
- **Status.** **Closed 2026-10-23** (RL-029). The confirmed API surface is:
  - `McpServer`, `registerTool(name, {title, description, inputSchema, outputSchema, annotations}, handler)`
  - `StdioServerTransport` from `/stdio`
  - `ctx.mcpReq.elicitInput`, `inputRequired`, `inputResponse`, `acceptedContent`, `createRequestStateCodec`
  - Tool `_meta` passthrough is not yet exercised. That is covered by MCP-002.

### OQ-06
- **Question.** Which Appium server and `appium-flutter-integration-driver` versions work together? The driver's `main` branch declares `appium: ^3.0.0`, but which released driver version supports Appium 2, which supports Appium 3, and is 2.0.3 published?
- **Impact.** APM-001/002 and the reuse of the Autotrader suite.
- **Owner (role).** Mobile Automation Architect.
- **Decision phase.** Phase 5 (APM-001), or earlier if capacity allows.
- **Closure criteria.** A verified compatible pair runs a fixture scenario, and the pinning configuration is documented.

### OQ-07
- **Closed (2026-10-24):** GHES is out of scope; only github.com is supported.
- **Question.** Which GHES version runs at `ghe.coxautoinc.com`? Are the Checks API, GitHub App installation, `GITHUB_TOKEN` with `checks: write`, OIDC, and ephemeral/JIT runner registration available?
- **Impact.** ADR-0013, the fallback order for GH-004, and the CI security design.
- **Owner (role).** DevSecOps Engineer.
- **Decision phase.** Phase 0 (DISC-005).
- **Closure criteria.** Each capability is recorded as yes or no, with evidence fixtures.
- **Status.** **Narrowed 2026-10-23.**
  - Version **3.21.6**. The documented capabilities are confirmed ([RL-036](research-log.md#rl-036--ghes-instance-version-and-documented-capabilities)).
  - Still open: the instance configuration (Actions, OIDC, App installation policy, ephemeral runner pool) and the recorded HTTP fixtures.
  - **Blocked on** credentials for an authorized org account.

### OQ-08
- **Question.** What `xcresulttool get test-results` subcommands and output schema does the target Xcode 26.x provide?
- **Impact.** IOS-003 parsing.
- **Owner (role).** Mobile Automation Architect.
- **Decision phase.** Phase 4 (IOS-001).
- **Closure criteria.** A corpus is captured, the parser strategy is selected, and the markers in platform-adapters.md are resolved.

### OQ-09
- **Question.** What are the exact Android result subpaths for each AGP version and variant? Do Gradle offline mode and the GMD options behave as documented?
- **Impact.** AND-003 and AND-004.
- **Owner (role).** Mobile Automation Architect.
- **Decision phase.** Phase 4 (AND-001).
- **Closure criteria.** A corpus is captured and the documentation is updated.

### OQ-10
- **Question.** What do Bitrise and Codemagic actually cost for this workload, and do they support integration with GHES?
- **Impact.** The cost and GHES-compatibility scores for OQ-01.
- **Owner (role).** DevSecOps Engineer.
- **Decision phase.** Phase 0 (DISC-004).
- **Closure criteria.** Quotes are in hand and the integration is confirmed or ruled out.

### OQ-11
- **Question.** Should Marionette MCP, which already lets an agent control the running Autotrader app, become an exploratory-driving adapter? What should the boundary between the two tools be?
- **Impact.** Possible future adapter. No impact on v1.x.
- **Owner (role).** Principal Architect, with the Autotrader team.
- **Decision phase.** After v1.1.
- **Closure criteria.** An ADR either accepts or declines the integration.

### OQ-12
- **Question.** How should AutoTest PR comments coexist with Claudius reviews? Options: a separate comment or a shared thread, plus de-duplication and labelling conventions.
- **Impact.** GH-003 UX, and reviewer noise.
- **Owner (role).** Autotrader engineering lead.
- **Decision phase.** Phase 2.
- **Closure criteria.** A convention is documented in ADR-0013 or a follow-up ADR.

### OQ-13
- **Question.** Which local AL3 mechanism should be used, for example a Keychain key that requires user presence, and how is it packaged?
- **Impact.** Local approvals cannot be stronger than AL2 until this is decided (RK-01).
- **Owner (role).** Security Engineer.
- **Decision phase.** Phase 0 (DISC-003). Implementation by Phase 3.
- **Closure criteria.** A prototype is verified and ADR-0006 is updated.
- **Status.** **Narrowed 2026-10-23** (DISC-003, [RL-035](research-log.md#rl-035--al3-approval-feasibility-on-macos)).
  - The Secure Enclave path requires a helper signed with Developer ID and a provisioning profile.
  - The FIDO2 path requires hardware keys.
  - **The organization decides** which to fund. Until then, the local maximum is AL2.

### OQ-14
- **Question.** Where are the missing `integration_test/package.json`, `tsconfig.json` and `scenario-list.json` for the Autotrader checkout? Can a complete checkout, with git metadata, be provided for acceptance testing?
- **Impact.** E2E-003 and APM-002.
- **Owner (role).** Autotrader engineering lead.
- **Decision phase.** Phase 0 (DISC-007).
- **Closure criteria.** A complete clone is available, or access is formally declined. If declined, the gated tasks are deferred.
- **Status.** **Blocked 2026-10-23.** This needs the Autotrader owners, which no automated step can provide (DISC-007).

### OQ-15
- **Question.** Which Flutter version is the source of truth for Autotrader: 3.38.4 (pubspec) or 3.38.10 (Bitrise)?
- **Impact.** The pinned SDK for E2E-003. This is also a good real-world example of the SDK-conflict reporting that AutoTest must handle.
- **Owner (role).** Autotrader engineering lead.
- **Decision phase.** Phase 0 (DISC-007).
- **Closure criteria.** The answer is recorded.
- **Status.** Open, and needs the Autotrader team. Both 3.38.4 and 3.38.10 are now in the parser corpus (RL-034), so whichever is chosen is already covered.

### OQ-16
- **Question.** Are baseline runs on the base ref (FR-047) worth their cost, given they need git worktrees and double the execution time? Or is a known-failure registry enough?
- **Impact.** The scope of ANL-002 and the accuracy of `pre_existing` classifications.
- **Owner (role).** Mobile QA Architect.
- **Decision phase.** Phase 2.
- **Closure criteria.** A pilot measurement is taken and a decision recorded.

### OQ-17
- **Question.** Are the retention defaults (14, 30 and 90 days, 5 GiB) acceptable to the organization's security and privacy owners?
- **Impact.** NFR-012 and EVD-003 defaults.
- **Owner (role).** Security Engineer, with the organization's privacy owner.
- **Decision phase.** Phase 3.
- **Closure criteria.** Defaults are approved or changed.

### OQ-18
- **Question.** Is Windows host support needed, and if so, when?
- **Impact.** NFR-006 currently only preserves the ability to support Windows; it is not a target.
- **Owner (role).** Product owner.
- **Decision phase.** After v1.0.
- **Closure criteria.** A decision is recorded.

### OQ-19
- **Question.** Which SQLite driver should be used: `node:sqlite` (release candidate on Node 26, experimental on Node 24) or a native driver?
- **Impact.** STO-002.
- **Owner (role).** Principal Architect.
- **Decision phase.** Phase 0 (DISC-008).
- **Closure criteria.** ADR-0008 is updated with benchmark evidence.
- **Status.** **Closed 2026-10-23**: `node:sqlite` ([RL-033](research-log.md#rl-033--nodesqlite-evaluation)).

## Risks

**Scales.** Likelihood (L) and impact (I) are each rated H, M or L.

### RK-01
- **Risk.** An agent with unrestricted shell access, running as the same OS user, bypasses AL2 approvals. It could run the CLI or edit the approval store or the pre-authorization file.
- **L/I.** M / H.
- **Mitigation.**
  - Claude Code deny rules and sandbox mode.
  - A TTY challenge in the CLI.
  - Approval-file integrity checks.
  - Requiring AL3 for sensitive scopes (DISC-003).
  - Every approval is audited.
- **Residual.** The CLI-001 TTY challenge (6 digest characters at random positions) stops an agent that cannot drive a terminal. It does not prove a human acted: a process that allocates a pseudo-terminal can answer it. Only AL3 closes this.
- **Owner (role).** Security Engineer.
- **Phase.** 0–3.
- **Closure criteria.** AL3 is available, and the default policy for sensitive scopes requires it. Alternatively, the residual risk is accepted in writing at SEC-004.

### RK-02
- **Risk.** Protocol or SDK churn: MCP 2026-07-28 and SDK v2 are only months old, and clients may lag behind.
- **L/I.** M / H.
- **Mitigation.** DISC-001. SDK-agnostic contracts. The ADR-0001 fallback to SDK v1.
- **Owner (role).** MCP Engineer.
- **Phase.** 0, then ongoing.
- **Closure criteria.** Interoperability verified, plus a pinned and tested client and SDK matrix.

### RK-03
- **Retired (2026-10-24):** no AutoTest CI. This repository runs its own checks only on release tags.
- **Risk.** macOS CI capacity is unavailable or too expensive. GitHub-hosted runners are not offered on GHES.
- **L/I.** M / M.
- **Mitigation.** v1.0 needs only Linux. macOS work is deferred to v1.1, and Bitrise (already used by the organization) or self-hosted Macs are evaluated (DISC-004).
- **Owner (role).** DevSecOps Engineer.
- **Phase.** 0 and 4.
- **Closure criteria.** A provider has been selected for macOS.

### RK-04
- **Risk.** Flaky tests lead to misclassification: product defects reported for flaky tests, or real defects hidden.
- **L/I.** H / M.
- **Mitigation.**
  - Bounded retries with a `flaky` label.
  - Conservative classification (product-defect findings are hypotheses by default).
  - Baselines and a known-failure registry.
  - Reports list flaky tests under "Attention".
- **Owner (role).** Mobile QA Architect.
- **Phase.** 1–2.
- **Closure criteria.** The fixture flaky scenarios are classified correctly, and pilot data shows an acceptable rate.

### RK-05
- **Risk.** Secret leakage through test output, screenshots or new secret formats.
- **L/I.** M / H.
- **Mitigation.** POL-005 redaction. Fail-closed quarantine. Screenshots are never published. Canary tests. Ruleset updates.
- **Owner (role).** Security Engineer.
- **Phase.** 1, then ongoing.
- **Closure criteria.** SEC-001 canaries pass, and no leak is found in the SEC-004 review.

### RK-06
- **Risk.** Private dependencies and credentials block acceptance testing against Autotrader.
- **L/I.** H / M.
- **Mitigation.** A public synthetic fixture for every required gate. Autotrader tests are gated by credentials (E2E-003). Early outreach (DISC-007).
- **Owner (role).** Principal Architect.
- **Phase.** 0–2.
- **Closure criteria.** E2E-003 passes, or is formally deferred.

### RK-07
- **Risk.** Result formats drift. Examples: the Flutter JSON protocol changes, and the Xcode result-bundle schema is unpublished.
- **L/I.** M / M.
- **Mitigation.**
  - Versioned parsers.
  - Corpora per toolchain version.
  - Protocol versions recorded in provenance.
  - Probe-based strategy selection.
- **Owner (role).** Mobile Automation Architect.
- **Phase.** 1 and 4.
- **Closure criteria.** The compatibility matrix is green for every supported toolchain version.

### RK-08
- **Risk.** Simulator or emulator state corruption on developer machines.
- **L/I.** M / M.
- **Mitigation.** Ownership leases. Devices owned by AutoTest by default. P2 approval for devices it doesn't own. Physical devices are never erased.
- **Owner (role).** Mobile Automation Architect.
- **Phase.** 4.
- **Closure criteria.** DEV-002 security tests pass.

### RK-09
- **Risk.** Scope creep across five platforms delays Release 1.
- **L/I.** H / M.
- **Mitigation.** Release 1 is Flutter host only. Platforms are added by capability, and the phases are strictly gated.
- **Owner (role).** Product owner.
- **Phase.** All.
- **Closure criteria.** v1.0 ships without platform tasks from Phase 4 or Phase 5.

### RK-10
- **Risk.** Rubber-stamp approvals: humans approve `needs_review` plans without reviewing them.
- **L/I.** M / M.
- **Mitigation.**
  - The CLI shows the findings and the scope and requires typing a challenge.
  - R3 always requires review.
  - Approvals are audited.
  - Reports state each approval's assurance level and the findings that were approved.
- **Owner (role).** Mobile QA Architect.
- **Phase.** 1–3.
- **Closure criteria.** A pilot review shows the findings were acted on.

### RK-11
- **Risk.** SQLite contention when several sessions, the CLI and supervisors all write at once.
- **L/I.** L / M.
- **Mitigation.** WAL mode, `busy_timeout`, short transactions, per-run file locks, and a two-process concurrency test.
- **Owner (role).** Principal Architect.
- **Phase.** 1.
- **Closure criteria.** STO-002 and OPS-006 concurrency tests pass.

### RK-12
- **Risk.** Client output limits truncate tool results. Claude Code warns above 10k tokens and caps output at 25k tokens or 50k characters.
- **L/I.** M / M.
- **Mitigation.** A 20k-character cap per tool response, pagination and artifact references (NFR-004).
- **Owner (role).** MCP Engineer.
- **Phase.** 1.
- **Closure criteria.** Contract tests assert the size limits.

### RK-13
- **Risk.** Prompt injection steers the agent into drafting a poor plan, or into asking for inappropriate actions.
- **L/I.** H / M.
- **Mitigation.**
  - No instruction channel into policy.
  - The coverage gate and authorization are independent of the agent.
  - The Skill tells the agent to report injection attempts.
  - SEC-002 and SKL-002.
- **Owner (role).** Security Engineer.
- **Phase.** 1.
- **Closure criteria.** SEC-002 and SKL-002 pass.

### RK-14
- **Risk.** An Appium, driver and platform-version incompatibility breaks existing suites.
- **L/I.** M / M.
- **Mitigation.** Mandatory version pinning, a probe that detects mismatches, and resolving OQ-06.
- **Owner (role).** Mobile Automation Architect.
- **Phase.** 5.
- **Closure criteria.** APM-001 passes with a pinned version pair.

### RK-15
- **Retired (2026-10-24):** GHES is out of scope.
- **Risk.** GHES feature gaps compared with github.com, such as the Checks API or OIDC.
- **L/I.** M / M.
- **Mitigation.** A capability probe (DISC-005) and fallback mechanisms (ADR-0013).
- **Owner (role).** DevSecOps Engineer.
- **Phase.** 0–2.
- **Closure criteria.** OQ-07 is closed and the fallbacks are tested.
