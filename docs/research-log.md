# Research Log

**Canonical home for:** external evidence, verification dates, and the boundary between verified facts and assumptions.
**Date of verification for all entries:** 2026-10-22, unless an entry says otherwise.
**Method:** Plan-mode subagents produced a first round of findings. The planning author then fetched the cited official pages directly, with no subagent involved, and read them in full where the tool allowed. Every entry with **High** confidence was re-verified this way. Two entries, RL-016 and RL-019, say "preliminary pass": they were *not* re-fetched and carry **Medium** confidence. Unverified items are labelled as such and linked to open questions.

The Autotrader observations (section B) came from read-only inspection: `find`, `grep`, `wc`, `sed -n` and `ls`. No commands that build, generate or fetch dependencies were run.

## Confidence scale

| Level | Meaning |
|---|---|
| **High** | Stated explicitly by an official primary source that I read directly. |
| **Medium** | Comes from an official source, but is indirect, version-dependent, or the source was only partly read. |
| **Low** | Comes from a secondary source or is inferred. It is never used as the basis for an `Accepted (planning)` decision. |
| **Unverified** | No adequate source was found. An open question exists for it in [risks-and-open-questions.md](risks-and-open-questions.md). |

---

## A. External ecosystem

### RL-001 — Current MCP specification revision
- **Claim / question:** Which MCP specification revision is current, and what changed in it?
- **Source:** "Key Changes", MCP Specification 2026-07-28 — https://modelcontextprotocol.io/specification/2026-07-28/changelog
- **Source type:** Official specification.
- **Date accessed:** 2026-10-22. **Version:** 2026-07-28. The previous revision was 2025-11-25.
- **Finding:** The 2026-07-28 changelog lists these changes:
  - Protocol-level sessions are removed, along with `Mcp-Session-Id`.
  - The `initialize` handshake is removed. Each request carries its protocol version and client capabilities in `_meta`.
  - `server/discover` is added, and servers MUST implement it.
  - Servers keep cross-call state through "explicit, server-minted handles passed as ordinary tool arguments".
  - Tasks are moved into an official extension, `io.modelcontextprotocol/tasks`.
  - The Multi Round-Trip Request (MRTR) `input_required` pattern replaces server-initiated requests, including elicitation.
  - SSE resumability is removed.
  - Roots, Sampling and Logging are deprecated, as are the HTTP+SSE transport and Dynamic Client Registration.
  - JSON-RPC error codes from -32020 to -32099 are reserved for the specification.
- **Confidence:** High.
- **Architectural impact:**
  - `runId`, `planId`, `approvalRequestId` and `cursor` are server-minted handles ([ADR-0007](architecture-decisions/ADR-0007.md)).
  - Logging goes to stderr ([observability](observability-and-failure-analysis.md)).
  - No Sampling dependency ([ADR-0004](architecture-decisions/ADR-0004.md)).
  - Server-defined error codes stay inside the -32000 to -32019 range, or are returned as tool execution errors ([mcp-tool-contracts](mcp-tool-contracts.md)).
- **Follow-up:** Confirm that Claude Code negotiates 2026-07-28 with an SDK v2 server ([OQ-02](risks-and-open-questions.md#oq-02)).

### RL-002 — Tool annotations are untrusted hints
- **Source:** "Tools", MCP Specification 2026-07-28 — https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- **Source type:** Official specification. **Date accessed:** 2026-10-22.
- **Finding:** The spec says "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers."
  - Servers MUST validate inputs, implement access controls, rate-limit invocations and sanitize outputs.
  - `outputSchema` + `structuredContent` are supported, and `structuredContent` may be any JSON value.
  - Tool execution errors use `isError: true`.
  - The spec's stateful-tool guidance recommends opaque handles with bounded lifetime, and expiry errors the model can recover from.
- **Confidence:** High.
- **Architectural impact:** Annotations are advisory only. Enforcement lives in `packages/policy` ([ADR-0014](architecture-decisions/ADR-0014.md), [security-threat-model](security-threat-model.md)).
- **Follow-up:** None.

### RL-003 — Elicitation in 2026-07-28
- **Source:** "Elicitation", MCP Specification 2026-07-28 — https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- **Source type:** Official specification. **Date accessed:** 2026-10-22.
- **Finding:**
  - Elicitation has form and URL modes and is delivered through `InputRequiredResult`.
  - The response actions are `accept`, `decline` and `cancel`.
  - Servers MUST NOT request secrets through form mode.
  - Servers "MUST NOT rely on client-provided user identification without server verification".
- **Confidence:** High.
- **Architectural impact:** An elicitation response is **client-attested**. It does not prove a human was present ([ADR-0006](architecture-decisions/ADR-0006.md)).
- **Follow-up:** See RL-008.

### RL-004 — Tasks extension
- **Sources:**
  - "Tasks" — https://modelcontextprotocol.io/extensions/tasks/overview
  - "Extension Support Matrix" — https://modelcontextprotocol.io/extensions/client-matrix
- **Source type:** Official documentation. **Date accessed:** 2026-10-22.
- **Finding:**
  - Tasks use `tasks/get`, `tasks/update` and `tasks/cancel`, and a task is created when the server returns `resultType: "task"`.
  - Statuses are `working`, `input_required`, `completed`, `failed` and `cancelled`. Cancellation is cooperative.
  - The client must opt in on each request.
  - The client matrix lists no client column for Tasks, and Claude Code is not listed.
- **Confidence:** High for the protocol details. **Update 2026-10-23:** Claude Code 2.1.169 does not use Tasks (RL-032).
- **Architectural impact:** Tasks are an optional adapter over the run manager and not a release-1 dependency ([ADR-0007](architecture-decisions/ADR-0007.md)).
- **Follow-up:** [OQ-03](risks-and-open-questions.md#oq-03).

### RL-005 — MCP TypeScript SDK v2
- **Sources:**
  - README — https://github.com/modelcontextprotocol/typescript-sdk
  - Server package manifest — https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/server/package.json
  - SDK docs — https://ts.sdk.modelcontextprotocol.io/
- **Source type:** Official repository and documentation. **Date accessed:** 2026-10-22.
- **Finding:**
  - v2 is "the stable release line" and implements spec 2026-07-28.
  - It ships as packages `@modelcontextprotocol/server`, `@modelcontextprotocol/client` and the middleware `@modelcontextprotocol/node|express|fastify|hono`.
  - `@modelcontextprotocol/server` is at **2.3.1**, with `engines.node: ">=20"`.
  - Its subpath exports include `./stdio` and `./validators/ajv`, and `zod` is a dependency.
  - The README example uses `new McpServer({...})` and `server.registerTool(name, { description, inputSchema: z.object(...) }, handler)`, with `StdioServerTransport` imported from `@modelcontextprotocol/server/stdio` and schemas from `import * as z from 'zod/v4'`. Schemas accept any Standard Schema library.
  - v1 (`@modelcontextprotocol/sdk`) gets fixes "for at least six months after the v2 release (2026-07-27)" and implements the spec only up to 2025-11-25.
- **Confidence:** High for the package names and the minimal API. **Medium** for the exact `registerTool` option names beyond the README example, `outputSchema` handling, and error helpers. I did not read the migration guide.
- **Architectural impact:** [ADR-0001](architecture-decisions/ADR-0001.md) and [ADR-0003](architecture-decisions/ADR-0003.md). The contracts doc deliberately shows schemas as Zod sketches and JSON examples, and does not show SDK call signatures.
- **Follow-up:** [OQ-05](risks-and-open-questions.md#oq-05) (DISC-001 spike).

### RL-006 — SDK v2 compatibility with older-protocol clients
- **Source:** https://ts.sdk.modelcontextprotocol.io/
- **Source type:** Official documentation. **Date accessed:** 2026-10-22.
- **Finding:** The documentation does not say whether a v2 server can negotiate with clients that speak 2025-11-25 or older. The 2026-07-28 changelog says `server/discover` can serve as "a backward-compatibility probe on STDIO".
- **Confidence:** Unverified at the baseline. **Update 2026-10-23: verified by experiment (RL-029, RL-030).**
- **Architectural impact:** This was a release blocker until verified. It is now resolved. If Claude Code cannot talk to a v2 server, [ADR-0001](architecture-decisions/ADR-0001.md) falls back to SDK v1 for the transport layer only. Contracts stay library-agnostic for that reason.
- **Follow-up:** [OQ-02](risks-and-open-questions.md#oq-02), DISC-001.

### RL-007 — Claude Code MCP behaviour relevant to this design
- **Source:** "Connect Claude Code to tools via MCP" — https://code.claude.com/docs/en/mcp (read in two parts)
- **Source type:** Official product documentation. **Date accessed:** 2026-10-22.
- **Finding:**
  - **Output limits:** Claude Code warns above 10,000 output tokens and limits output to 25,000 tokens by default (`MAX_MCP_OUTPUT_TOKENS`). A text result over 50,000 characters is saved to a file unless the tool sets `_meta["anthropic/maxResultSizeChars"]`, with a ceiling of 500,000. Error text over about 11,000 characters is truncated to its head and tail.
  - **Timeouts and backgrounding:** A tool call still running after two minutes moves to a background task. The stdio idle timeout is 30 minutes. `MCP_TOOL_TIMEOUT` and a per-server `timeout` are configurable.
  - **Configuration:** `.mcp.json` supports `command`/`args`/`env` with `${VAR}` expansion, and project servers require approval.
  - **Forced approval:** `_meta["anthropic/requiresUserInteraction"]: true` forces a permission prompt on every call, even in bypass modes. Under `--permission-prompt-tool` an `allow` is converted to a deny, but the Agent SDK's `canUseTool` callback can approve the call.
  - **Elicitation:** Claude Code supports both form and URL elicitation through a dialog, and it declares both modes on 2026-07-28 connections.
  - **Elicitation hook:** "To auto-respond to elicitation requests without showing a dialog, use the `Elicitation` hook."
- **Confidence:** High.
- **Architectural impact:**
  - Responses are kept small, with pagination and artifact references ([mcp-tool-contracts](mcp-tool-contracts.md)).
  - `run_tests` returns immediately ([ADR-0007](architecture-decisions/ADR-0007.md)).
  - `publish_github_report` and `request_approval` set `anthropic/requiresUserInteraction` as defense in depth. That flag is a client control and is not relied on as the server's authorization ([ADR-0006](architecture-decisions/ADR-0006.md)).
  - Because a hook can answer an elicitation, **elicitation responses are classified as assurance level AL1 only** (RL-008).
- **Follow-up:** [OQ-04](risks-and-open-questions.md#oq-04).

### RL-008 — Elicitation is not proof of a human (derived finding)
- **Derived from:** RL-003 and RL-007.
- **Finding:** The MCP server cannot distinguish a human answering an elicitation dialog from a configured `Elicitation` hook, or from an SDK host whose `canUseTool` callback approves automatically.
- **Confidence:** High. Both behaviours are documented.
- **Architectural impact:** Approval assurance levels AL1–AL3 ([ADR-0006](architecture-decisions/ADR-0006.md)). Under default policy, elicitation (AL1) may satisfy only P1-level confirmations. It is never enough for `needs_review` plan approval, P2 or P3.
- **Follow-up:** [OQ-04](risks-and-open-questions.md#oq-04), [OQ-13](risks-and-open-questions.md#oq-13).

### RL-009 — Agent Skills specification
- **Source:** "Specification", Agent Skills — https://agentskills.io/specification
- **Source type:** Official open specification. **Date accessed:** 2026-10-22.
- **Finding:**
  - The frontmatter fields are `name` (required; 1–64 characters; lowercase alphanumerics and single hyphens; must match the directory), `description` (required; 1–1024 characters), `license`, `compatibility` (≤500 characters), `metadata` (string→string map) and `allowed-tools` (experimental).
  - The guidance is to keep `SKILL.md` under 500 lines, with references one level deep. The body is recommended to stay under about 5,000 tokens.
- **Confidence:** High.
- **Architectural impact:** [agent-skill-spec](agent-skill-spec.md) and `skills/pr-mobile-autotest/SKILL.md` use only `name`, `description`, `license`, `compatibility` and `metadata`. `allowed-tools` is omitted because it is experimental and must not be taken as a grant of trust.
- **Follow-up:** Validate with `skills-ref validate` (SKL-001).

### RL-010 — Claude Code Skill discovery and extensions
- **Source:** "Extend Claude with skills" — https://code.claude.com/docs/en/skills
- **Source type:** Official product documentation. **Date accessed:** 2026-10-22.
- **Finding:**
  - Claude Code discovers skills in these locations:
    - `~/.claude/skills/<name>/SKILL.md`
    - `.claude/skills/<name>/SKILL.md`, including parents up to the repo root
    - nested `.claude/skills`
    - `--add-dir`
    - plugins (`<plugin>/skills/<name>/SKILL.md`, namespaced `/plugin:skill`)
    - managed enterprise settings
  - Claude Code adds its own frontmatter fields, for example `disable-model-invocation`, `context`, `hooks` and `paths`. It ignores unknown fields, but claude.ai and the Skills API reject non-spec fields.
  - The `description` plus `when_to_use` is truncated at 1,536 characters in the listing.
- **Confidence:** High.
- **Architectural impact:** The Skill stays within the six spec fields for portability. Claude Code packaging is documented as a project skill or as a plugin that bundles the MCP server ([agent-skill-spec](agent-skill-spec.md)).
- **Follow-up:** None.

### RL-011 — Node.js release status
- **Source:** nodejs/Release schedule — https://github.com/nodejs/Release
- **Source type:** Official. **Date accessed:** 2026-10-22.
- **Finding:**

  | Line | Status column | Released | Active LTS | Maintenance | EOL |
  |---|---|---|---|---|---|
  | 22.x | Maintenance LTS | — | 2024-10-29 | 2025-10-21 | 2027-04-30 |
  | 24.x | Active LTS | — | 2025-10-28 | 2026-10-20 | 2028-04-30 |
  | 26.x | Current | 2026-05-05 | 2026-10-28 | 2027-10-20 | 2029-04-30 |

  The 24.x status column still reads "Active LTS" even though its maintenance start date (2026-10-20) has passed. The page notes "Dates are subject to change."
- **Confidence:** High for the dates. Medium for how current the status column is.
- **Architectural impact:**
  - On 2026-10-22, **Node 26 is "Current"** and is scheduled to enter Active LTS on 2026-10-28.
  - [ADR-0001](architecture-decisions/ADR-0001.md) and NFR-001 make Node 26 the primary target *from its Active LTS date*, with Node 24 as the compatibility target. 24 should be treated as having entered Maintenance on 2026-10-20 according to the schedule.
  - Before the transition, development may use Node 24 or Node 26 Current.
- **Follow-up:** Re-check during Phase 0 exit (DISC-001).

### RL-012 — `node:sqlite` stability
- **Source:** Node.js API docs, SQLite — https://nodejs.org/api/sqlite.html (documents v26.12.1)
- **Source type:** Official. **Date accessed:** 2026-10-22.
- **Finding:** The module is marked "Stability: 1.2 – Release candidate" in the v26 docs. It has not been behind `--experimental-sqlite` since v22.13.0 / v23.4.0, and the history shows it was promoted to release candidate in v25.7.0. That means it is still experimental on the Node 24 line.
- **Confidence:** High for v26. Medium for v24, which was inferred from the history table.
- **Architectural impact:** [ADR-0008](architecture-decisions/ADR-0008.md) accepts SQLite as the store but leaves the **driver** (built-in `node:sqlite` versus a native addon) open.
- **Follow-up:** [OQ-19](risks-and-open-questions.md#oq-19), DISC-008. **Update 2026-10-23: resolved by RL-033.**

### RL-013 — JSON Canonicalization Scheme
- **Source:** RFC 8785 — https://www.rfc-editor.org/rfc/rfc8785
- **Source type:** IETF RFC (Informational). **Date accessed:** 2026-10-22.
- **Finding:** JCS sorts object properties recursively by UTF-16 code units, keeps array order, serializes numbers the ECMAScript way, removes whitespace, and encodes the result as UTF-8. Inputs must be I-JSON; NaN, Infinity and lone surrogates are errors.
- **Confidence:** High.
- **Architectural impact:** Plan-hash canonicalization ([data-model §Plan hash](data-model-and-artifacts.md#plan-hash-specification), [ADR-0005](architecture-decisions/ADR-0005.md)). The status is Informational, which is fine because the algorithm is fully specified.
- **Follow-up:** None.

### RL-014 — Flutter `flutter test` reporting options
- **Source:** flutter_tools `test.dart` (master) — https://raw.githubusercontent.com/flutter/flutter/master/packages/flutter_tools/lib/src/commands/test.dart
- **Source type:** Official source code. **Date accessed:** 2026-10-22. **Version:** master branch. It may differ from 3.38.x.
- **Finding:**
  - **Reporting:** `--reporter` takes `compact|expanded|failures-only|github|json|silent`. `--file-reporter <reporter>:<path>` adds a reporter that writes to a file, for example `json:reports/tests.json`. `--machine` exists.
  - **Selection:** `--name` (regex), `--plain-name`, `--tags`/`--exclude-tags`, and `--total-shards`/`--shard-index`.
  - **Coverage and execution:** `--coverage`/`--coverage-path` (default `coverage/lcov.info`), `--timeout`, `--concurrency` and `--test-randomize-ordering-seed`.
  - There is no built-in JUnit reporter.
- **Confidence:** High for master. **Update 2026-10-23:** verified on 3.38.4, 3.38.10, 3.41.9 and 3.47.1 (RL-034).
- **Architectural impact:** The Flutter adapter uses `--file-reporter json:<run-dir>/flutter-test.jsonl`, parses it, and writes JUnit itself ([platform-adapters §Flutter](platform-adapters.md#flutter)).
- **Follow-up:** DISC-006 captures real output from Flutter 3.38.x.

### RL-015 — Dart test JSON reporter protocol
- **Source:** `json_reporter.md` — https://github.com/dart-lang/test/blob/master/pkgs/test/doc/json_reporter.md
- **Source type:** Official. **Date accessed:** 2026-10-22.
- **Finding:**
  - The event types are `start` (with `protocolVersion`), `allSuites`, `suite`, `group`, `testStart`, `print`, `error`, `testDone` and `done`.
  - `testDone.result` is one of `success|failure|error`.
  - `hidden` marks tests that don't count, such as setUpAll and loading tests. `skipped` is authoritative.
  - An `error` event can arrive after `testDone`, and the test is then counted as failed.
  - `done.success` is null if the runner closed early.
- **Confidence:** High.
- **Architectural impact:** These rules map into the normalized outcomes in [platform-adapters §Flutter](platform-adapters.md#flutter). `done.success == null` maps to `infra_error` for the run attempt.
- **Follow-up:** Record the protocol version in the evidence metadata.

### RL-016 — JUnit conversion package for Flutter
- **Source:** pub.dev `junitreport`, found during the preliminary research.
- **Source type:** Package registry. **Date accessed:** 2026-10-22 (preliminary pass).
- **Finding:** The package was last published about four years ago.
- **Confidence:** Medium. This was a secondary pass and was not re-fetched.
- **Architectural impact:** The project does not depend on it. JUnit is written by `packages/adapter-sdk` helpers (ADP-002).
- **Follow-up:** None.

### RL-017 — Xcode result bundles
- **Sources:**
  - Apple Developer Forums threads 763888 and 763050 — https://developer.apple.com/forums/thread/763888 and https://developer.apple.com/forums/thread/763050
- **Source type:** The forums include Apple DTS answers. There is no reference page. **Date accessed:** 2026-10-22.
- **Finding:**
  - From Xcode 16, the legacy `xcresulttool get --format json` requires `--legacy`.
  - The replacement is `xcrun xcresulttool get test-results summary --path <bundle> [--compact]`. Apple DTS recommends `xcrun xcresulttool help get test-results summary` to see the schema.
  - The `tests` and `test-details` subcommands appear only in secondary sources.
  - Developers report that no published format exists.
- **Confidence:** Medium for `summary`. **Low** for `tests` and `test-details`.
- **Architectural impact:** The iOS adapter parses through a version-probed strategy, starting with `help` introspection ([platform-adapters §iOS](platform-adapters.md#native-ios)). Phase 3 cannot start iOS parsing until IOS-001 is done.
- **Follow-up:** [OQ-08](risks-and-open-questions.md#oq-08).
- **Verified 2026-10-25 (IOS-001)** on Xcode 26.4.1 (xcresulttool 24757), iOS 26.4 simulator, with `fixtures/fixture-ios` (hand-written project, objectVersion 77; corpus `fixtures/ios-corpus/xcode-26.4.1/`):
  - `xcodebuild test -project <p> -scheme <s> -destination id=<udid> -resultBundlePath <dir>/Test.xcresult -derivedDataPath <dir>` works; `-only-testing:<Target>/<Class>[/<method>]` selects (repeatable). Exit code 0 when all pass, 65 for test failures **and** for build failures.
  - `xcrun xcresulttool get test-results tests --path <bundle> --compact` (no `--legacy`) returns a node tree: `nodeType` `Unit test bundle` / `UI test bundle` / `Test Suite` / `Test Case`; each case has `nodeIdentifier` (`Class/method()`), `result` (`Passed`, `Failed`, `Skipped`, `Expected Failure`), `durationInSeconds`, and `Failure Message` children. The string `duration` is locale-formatted (`0,31s`): do not parse it.
  - `get test-results summary` gives counts and `result` (`Passed`, `Failed`, or `unknown` with zero tests when the build failed). `get build-results` lists compiler errors (`issueType: "Swift Compiler Error"`), which tells a build failure from a test failure.
  - `xcodebuild -list -json -project <p>` lists schemes and targets without building.
  - **Confidence:** High for Xcode 26.4.1. The adapter still probes `xcresulttool version` and records it.

### RL-018 — Android test result locations
- **Source:** "Test from the command line" — https://developer.android.com/studio/test/command-line
- **Source type:** Official. **Date accessed:** 2026-10-22.
- **Finding:**
  - `./gradlew test` writes HTML to `<module>/build/reports/tests/` and XML to `<module>/build/test-results/`.
  - `./gradlew connectedAndroidTest` writes HTML to `<module>/build/reports/androidTests/connected/` and XML to `<module>/build/outputs/androidTest-results/connected/`.
  - The variant tasks are `test<Variant>UnitTest` and `connected<Variant>AndroidTest`, with the `--tests` filter for unit tests.
  - `adb shell am instrument -w -e class …` filters instrumented tests.
- **Confidence:** High for the directories. **Medium** for the exact subfolders per variant and AGP version, which the documentation does not spell out.
- **Architectural impact:** The Android adapter discovers XML recursively under the documented roots and does not hard-code subpaths ([platform-adapters §Android](platform-adapters.md#native-android)).
- **Follow-up:** [OQ-09](risks-and-open-questions.md#oq-09).
- **Verified 2026-10-25 (AND-001)** with Gradle 9.3.1, AGP 9.1.0, JDK 21, API 36 emulator (`fixtures/fixture-android`; corpus `fixtures/android-corpus/agp-9.1.0/`):
  - Unit: `./gradlew testDebugUnitTest --console=plain [--tests <Class|Class.method>] [--offline]` writes `app/build/test-results/testDebugUnitTest/TEST-<class>.xml`; Gradle deletes earlier results of the task first. Exit 1 when a test fails. `@Ignore` appears as `<skipped/>`.
  - Instrumented: `./gradlew connectedDebugAndroidTest --console=plain` with `ANDROID_SERIAL=<serial>` writes `app/build/outputs/androidTest-results/connected/debug/TEST-<device> - <api>-_app-.xml`; class or method selection with `-Pandroid.testInstrumentationRunnerArguments.class=<Class>[#method]` keeps the XML output (`am instrument` gives text only).
  - `adb -s <serial> logcat -d` dumps the log; `emulator -avd <name> -no-window -no-snapshot -port <even port>` boots headless (serial `emulator-<port>`); the emulator refuses to start when the disk is nearly full (needs about 8 GB free; `-partition-size` lowers the data partition).
  - **Confidence:** High for this AGP version; other AGP versions may change the subfolders, so XML is still found recursively.
- **Verified 2026-10-25 (AND-003/004)**, same versions, through the adapter: the JDK runs the wrapper directly (`java -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain <task> … --offline --no-daemon --console=plain`) with a minimal environment (`ANDROID_HOME`, `JAVA_HOME`, `GRADLE_USER_HOME`, run-scoped `HOME`); `--rerun` forces the unit-test task; `--project-prop android.testInstrumentationRunnerArguments.class=<Class>` selects instrumented classes; `--no-daemon` leaves no Gradle process behind. AGP also writes per-test `logcat-<Class>-<method>.txt` next to the connected XML.

### RL-019 — Gradle Managed Devices
- **Source:** https://developer.android.com/studio/test/managed-devices, from the preliminary pass.
- **Source type:** Official. **Date accessed:** 2026-10-22. I did not re-fetch it this session.
- **Finding:**
  - Devices are configured under `testOptions.managedDevices`.
  - ATD images are API 30 only.
  - GPU-less CI uses `-Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect`.
- **Confidence:** Medium.
- **Architectural impact:** This is an optional Android CI strategy in Phase 3 and is not a requirement.
- **Follow-up:** Re-verify in AND-001.

### RL-020 — React Native testing guidance
- **Sources:**
  - https://reactnative.dev/docs/testing-overview
  - https://github.com/wix/Detox/releases
  - https://docs.maestro.dev/cli/test-suites-and-reports
- **Source type:** Official. **Date accessed:** 2026-10-22.
- **Finding:**
  - The React Native template ships Jest with an RN preset. React Native Testing Library is recommended for component tests, and React's Test Renderer is listed as deprecated. Detox, Appium and Maestro are named for E2E.
  - The latest Detox release is 20.51.3 (30 May; the page shows no year). Its notes mention RN 0.83 and 0.84 support.
  - Maestro produces JUnit with `maestro test --format junit --output <file>`.
- **Confidence:** High. The Detox release year is unverified.
- **Architectural impact:** RN adapter scope ([platform-adapters §React Native](platform-adapters.md#react-native)), Phase 4.
- **Follow-up:** Re-check versions at the start of Phase 4.

### RL-021 — Appium current version
- **Source:** appium `package.json` (master) — https://raw.githubusercontent.com/appium/appium/master/packages/appium/package.json
- **Source type:** Official source. **Date accessed:** 2026-10-22.
- **Finding:** Appium is at version **3.8.0**, with `engines.node` `^20.19.0 || ^22.12.0 || >=24.0.0`. The preliminary pass also reported a 4.0.0 beta, which I did not re-verify.
- **Confidence:** High for 3.8.0.
- **Architectural impact:** The Appium adapter pins the server and driver versions per project ([ADR-0011](architecture-decisions/ADR-0011.md)).
- **Follow-up:** None.

### RL-022 — `appium-flutter-integration-driver` and Appium 3
- **Sources:**
  - Repository — https://github.com/AppiumTestDistribution/appium-flutter-integration-driver
  - `package.json` (main) — https://raw.githubusercontent.com/AppiumTestDistribution/appium-flutter-integration-driver/main/package.json
- **Source type:** The project repository, which is community-maintained. **Date accessed:** 2026-10-22.
- **Finding:**
  - The `main` branch is at version **2.0.3** with `peerDependencies.appium: ^3.0.0`.
  - The README installs the driver with `appium driver install --source npm appium-flutter-integration-driver`. The app needs `appium_flutter_server` and `integration_test/appium_test.dart`.
  - I could not tell from these pages whether 2.0.3 is published to npm, or which driver major supports Appium 2.
- **Confidence:** **Medium.** Appium 3 is the intended peer on `main`. The released-artifact pairing is **Unverified**.
- **Architectural impact:** Autotrader's README says "Appium 2.x", but it installs Appium with an unpinned `npm i -g appium`, which installs the latest major. The adapter must pin a compatible server/driver pair ([ADR-0011](architecture-decisions/ADR-0011.md)).
- **Follow-up:** [OQ-06](risks-and-open-questions.md#oq-06).

### RL-023 — GitHub Checks API write access
- **Sources:**
  - REST "Check runs" — https://docs.github.com/en/rest/checks/runs
  - GHES 3.22 version — https://docs.github.com/en/enterprise-server@latest/rest/checks/runs
- **Source type:** Official. **Date accessed:** 2026-10-22.
- **Finding:**
  - "Write permission for the REST API to interact with checks is only available to GitHub Apps." OAuth apps and users can only read.
  - A request carries at most 50 annotations. Annotation message and raw_details are limited to 64 KB each and the title to 255 characters. A suite allows 1,000 runs with the same name.
  - The GHES 3.22 docs document the same endpoint at `https://HOSTNAME/api/v3`.
- **Confidence:** High.
- **Architectural impact:** [ADR-0013](architecture-decisions/ADR-0013.md). Check runs require a GitHub App installation, or `GITHUB_TOKEN` inside Actions (RL-024). Commit statuses are the fallback.
- **Follow-up:** [OQ-07](risks-and-open-questions.md#oq-07) asks which GHES version runs at `ghe.coxautoinc.com`.

### RL-024 — `GITHUB_TOKEN` checks permission
- **Source:** "Workflow syntax", permissions — https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions
- **Source type:** Official (github.com docs). **Date accessed:** 2026-10-22.
- **Finding:**
  - The docs say "`checks: write` permits an action to create a check run."
  - Fork PRs on `pull_request` get read-only tokens unless an admin setting allows write tokens. `pull_request_target` gets write access.
- **Confidence:** High for github.com. **Update 2026-10-23:** documented for GHES 3.21, the instance version (RL-036). Instance configuration is still unverified.
- **Architectural impact:** In CI mode on Actions, `GITHUB_TOKEN` with `checks: write` is the preferred credential. The design never uses `pull_request_target` to run untrusted PR code with secrets ([security-threat-model](security-threat-model.md)).
- **Follow-up:** [OQ-07](risks-and-open-questions.md#oq-07).

### RL-025 — Fine-grained PAT permissions
- **Source:** "Permissions required for fine-grained personal access tokens" — https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- **Source type:** Official. **Date accessed:** 2026-10-22.
- **Finding:**

  | Endpoint | Required permission |
  |---|---|
  | `GET pulls/{n}` | Contents (read) or Pull requests (read) |
  | `GET pulls/{n}/files` | Pull requests (read) |
  | `POST`/`PATCH` issue comments | Issues (write) or Pull requests (write) |
  | `POST statuses/{sha}` | Commit statuses (write) |

  Creating comments can trigger secondary rate limits.
- **Confidence:** High.
- **Architectural impact:** The least-privilege credential matrix in [security-threat-model §GitHub](security-threat-model.md#github-credential-matrix).
- **Follow-up:** None.

### RL-026 — GitHub-hosted runners on GHES
- **Sources:** GHES docs, "About GitHub-hosted runners" (3.12) and "Using GitHub-hosted runners" (3.19/3.20) — https://docs.github.com/en/enterprise-server@3.20/actions/how-tos/manage-runners/github-hosted-runners/use-github-hosted-runners
- **Source type:** Official (from search results). **Date accessed:** 2026-10-22.
- **Finding:** "GitHub-hosted runners are not supported on GitHub Enterprise Server". GHES users should use self-hosted runners.
- **Confidence:** Medium. This comes from search-result excerpts of the official pages, and the latest GHES release notes were not checked.
- **Architectural impact:** In the CI comparison, the "GitHub Actions" option for a GHES org means **self-hosted** runners, macOS included. The GitHub-hosted macOS price in RL-027 does not apply ([local-and-ci-execution §CI provider comparison](local-and-ci-execution.md#ci-provider-comparison)).
- **Follow-up:** Part of [OQ-01](risks-and-open-questions.md#oq-01).

### RL-027 — CI pricing (published list prices, not quotes)
- **Sources:**
  - GitHub Actions runner pricing — https://docs.github.com/en/billing/reference/actions-runner-pricing
  - Codemagic pricing — https://docs.codemagic.io/billing/pricing/
  - Bitrise pricing — https://bitrise.io/pricing
- **Source type:** Official vendor pages. **Date accessed:** 2026-10-22.
- **Finding:**
  - **GitHub-hosted:**

    | Runner | Price |
    |---|---|
    | Linux 2-core | $0.006/min |
    | macOS 3/4-core | $0.062/min |
    | macOS 12-core | $0.077/min |
    | macOS M2 Pro 5-core | $0.102/min |

  - **Codemagic:**
    - Pay-as-you-go: macOS M2 $0.095/min, macOS M4 $0.114/min, Linux $0.045/min.
    - Team annual plans: M2 $3,990/yr with 3 concurrencies; M4 $5,400/yr.
    - Enterprise starts at $12k/yr.
  - **Bitrise:**
    - Starter from $89/mo (annual), with up to 4 concurrencies.
    - Pro from $200/mo (annual), with up to 10 macOS concurrencies.
    - Enterprise is custom-priced.
    - The listed per-minute rates (for example M2 Pro Large $0.0096) look credit- or plan-based, and I could not interpret them reliably.
  - GHES support was not stated on the Codemagic or Bitrise pricing pages.
- **Confidence:** Medium. The prices are list prices on the access date; contract pricing will differ.
- **Architectural impact:** These are inputs to [ADR-0012](architecture-decisions/ADR-0012.md), which stays `Proposed`.
- **Follow-up:** [OQ-10](risks-and-open-questions.md#oq-10).

### RL-028 — Self-hosted runner support and ephemerality
- **Source:** "Self-hosted runners" reference — https://docs.github.com/en/actions/reference/runners/self-hosted-runners
- **Source type:** Official. **Date accessed:** 2026-10-22.
- **Finding:**
  - The runner supports macOS 11 or later. ARM64 support is "currently in public preview" across operating systems.
  - `--ephemeral` registers a runner for a single job, and just-in-time runners are available through the API.
  - The docs recommend ephemeral runners for autoscaling.
- **Confidence:** High.
- **Architectural impact:** The self-hosted Mac option requires ephemeral or wiped runners for any job that runs untrusted PR code ([security-threat-model](security-threat-model.md), [local-and-ci-execution](local-and-ci-execution.md)).
- **Follow-up:** Confirm the ARM64 preview status for Apple-silicon Macs in DISC-004.

---

## B. Autotrader reference repository (read-only inspection, 2026-10-22)

The checkout at `/Users/smjle/Documents/Autotrader` has **no `.git` directory**, so git metadata is unavailable. All facts below come from file contents, and the line references point to that checkout.

| ID | Observation | Evidence | Confidence | Impact |
|---|---|---|---|---|
| RL-A01 | `pubspec.yaml` declares `environment.flutter: 3.38.4` and `sdk: ">=3.0.0"`. | `pubspec.yaml` lines 21–23 | High | The Flutter adapter reads the SDK constraint from pubspec (FL-001). |
| RL-A02 | Bitrise sets `CURRENT_FLUTTER_VERSION: 3.38.10`, and `bitrise/_bundles.yml` uses `$FVM_FLUTTER_VERSION`. | `bitrise.yml:35` | High | SDK drift. The adapter reports the conflict and does not pick a version ([OQ-15](risks-and-open-questions.md#oq-15)). |
| RL-A03 | `.fvm/` and `.fvmrc` are gitignored (`.gitignore:48-49`). `.github/actions/setup-flutter/action.yml:15-18` defaults `flutter-version-file` to `.fvmrc`. | Files cited | High | No `.fvmrc` exists in the checkout. A missing version file is reported as a limitation. |
| RL-A04 | There are 775 `*_test.dart` files: unit_tests 474, widget 251, src 47, analytics 1, config 1, performance 1, helpers 0, mocks 0. | `find test -name '*_test.dart'` | High | Inventory scale fixture. The inventory output must be paginated. |
| RL-A05 | The dev_dependencies include `flutter_test`, `integration_test`, `bloc_test ^10.0.0`, `mocktail ^1.0.4`, `fake_async`, `hive_test`, `http_mock_adapter`, `appium_flutter_server ^0.0.33` and `marionette_mcp ^0.5.0`. No test uses `matchesGoldenFile`, and `patrol` does not appear in `pubspec.yaml`. | `pubspec.yaml` dev_dependencies | High | These feed the inventory helper detection. |
| RL-A06 | The CI test job runs `flutter test ${{ matrix.tests }} --reporter=github --no-fatal-warnings --coverage`. Of the workflow jobs, 60 use the `cai-standard-x86-linux` runner label. | `.github/workflows/test-coverage-analysis.yml:140`; `grep runs-on` | High | Host Flutter tests are Linux-capable. No JUnit output is produced. |
| RL-A07 | The workflows reference GHE at `ghe.coxautoinc.com`. | Workflow and documentation references | High | GHE `baseUrl` support is required (FR-002). |
| RL-A08 | Bitrise runs on stack `osx-xcode-26.3.x` with machine `g2.mac.large`. | `bitrise.yml:16-17` | High | iOS builds currently run only on Bitrise. This is an input to [OQ-01](risks-and-open-questions.md#oq-01). |
| RL-A09 | The integration test entry point is `integration_test/appium_test.dart`. The TypeScript driver uses `webdriverio` (`integration_test/src/index.ts:1`). `src/scenario.ts` contains 27 `case "…"` scenario branches. | `grep` | High | Reference profile for the Appium adapter. |
| RL-A10 | There are 18 Markdown files under `integration_test/spec/`, including the README. A sampled spec uses the sections `Intention`, `Preconditions`, `Flow` and `Expected Outcome`. | `find`; heading `grep` | High | A natural format for linking spec text to tests. |
| RL-A11 | `integration_test/package.json`, `tsconfig.json` and `scenario-list.json` are absent from this checkout. | `ls` | High | The TypeScript suite cannot be built from this checkout ([OQ-14](risks-and-open-questions.md#oq-14)). |
| RL-A12 | Results are written as `flakiness_summary*.tsv` plus text logs. No JUnit appears in `integration_test`. | `run_local.sh:224`; wrapper scripts lines 507 and 576 | High | The Appium adapter must parse exit codes, logs and TSV. |
| RL-A13 | `integration_test/README.md:74-80` says "Appium 2.x installed globally" but installs with an unpinned `npm i -g appium`, then runs `appium driver install --source=npm appium-flutter-integration-driver`. | README | High | Version-pairing risk (RL-022, [OQ-06](risks-and-open-questions.md#oq-06)). |
| RL-A14 | `integration_test/src/constants/mobile_apps_constant.ts` contains 3 lines that mention "password". **The values were not read into, or reproduced in, any document.** | `grep -c` | High | Threat-model example of secrets committed in repo content (T-05). |
| RL-A15 | `lib/main.dart` initializes `MarionetteBinding` (lines 7–8 and 25). `cladius.yml` uses `dsnextgen/claudius@v1` with `model: "claude-sonnet-latest"`. `.specify/memory/constitution.md` exists. | `grep` | High | Adjacent tools ([OQ-11](risks-and-open-questions.md#oq-11), [OQ-12](risks-and-open-questions.md#oq-12)). |
| RL-A16 | `pub get` needs Artifactory and GHE SSH credentials, based on the `setup-flutter` action inputs `ssh-key` and `pub-token` and the private packages in `pubspec.yaml`. | Action file; preliminary inspection | Medium | Autotrader acceptance testing is credential-gated (E2E-003). |

---

## C. Verified facts vs. assumptions vs. recommendations

- **Verified facts:** Entries marked High above.
- **Assumptions:** These are listed as A-NN in [product-requirements §Assumptions](product-requirements.md#assumptions). Each assumption links to the open question that would invalidate it.
- **Recommendations / provisional decisions:**
  - [ADR-0012](architecture-decisions/ADR-0012.md): the CI provider is `Proposed`.
  - [ADR-0008](architecture-decisions/ADR-0008.md): the SQLite driver sub-decision is open.
  - [ADR-0006](architecture-decisions/ADR-0006.md): the AL3 mechanism choice depends on DISC-003.
- **Unresolved compatibility questions:** [OQ-02](risks-and-open-questions.md#oq-02) through [OQ-10](risks-and-open-questions.md#oq-10) and [OQ-19](risks-and-open-questions.md#oq-19).

---

## D. Phase 0 spike findings (executed 2026-10-23, local time; DISC tasks)

These findings come from experiments in `spikes/` and captured fixtures in `fixtures/`. Spikes are throwaway and are not part of the product.

### RL-029 — SDK v2 supports both protocol eras over stdio
- **Claim / question:** Can an SDK v2 stdio server serve clients that still use the 2025-era `initialize` handshake?
- **Source:** Installed package code: `@modelcontextprotocol/server@2.3.1` and `@modelcontextprotocol/core@2.3.1` (`core/dist/auth-*.mjs`, `server/dist/stdio.mjs`). Spike `spikes/disc-001`.
- **Source type:** Primary (package source, plus an executed experiment). **Date accessed:** 2026-10-23.
- **Finding:**
  - `SUPPORTED_PROTOCOL_VERSIONS` lists the legacy versions: `2025-11-25` (as `LATEST_PROTOCOL_VERSION`), `2025-06-18`, `2025-03-26`, `2024-11-05` and `2024-10-07`.
  - The stdio transport classifies each opening message as either modern (2026-07-28 `_meta` envelope) or legacy (`initialize`).
  - Elicitation: `ctx.mcpReq.elicitInput()` works on legacy connections. On 2026-07-28 connections, handlers return `inputRequired(...)` and read `ctx.mcpReq.inputResponses` (helpers `inputResponse` and `acceptedContent`) on retry.
  - The SDK v2 client, connecting to the spike server over stdio, negotiated `2025-11-25` on Node 22.19.0, 24.22.1 and 26.12.1.
  - `outputSchema`, `structuredContent`, `isError` results and schema-validation errors returned as `isError` all worked on all three Node versions.
- **Confidence:** High.
- **Architectural impact:** ADR-0001 is confirmed; no SDK v1 fallback is needed. Tool handlers that use elicitation must implement both era paths (see AUTH-004).
- **Follow-up:** None.

### RL-030 — Claude Code 2.1.169 interoperability
- **Source:** Headless `claude -p` runs, version **2.1.169** (CLI), against the spike server through a logging stdio proxy (`spikes/disc-001/proxy.mjs`).
- **Source type:** Executed experiment. **Date accessed:** 2026-10-23.
- **Finding:**
  - **Handshake:** Claude Code sent `initialize` with `protocolVersion: "2025-11-25"`. `clientInfo` was `claude-code 2.1.169`. Capabilities were `{roots: {}, elicitation: {}}`; an empty elicitation object means form-only. The SDK v2 server accepted the handshake and `tools/list` succeeded.
  - **Results:** `structuredContent` and `isError: true` results reached the model.
  - **Size limits:** a 60,000-character text result was saved to a file under `~/.claude/projects/.../tool-results/`, with only about a 2 KB preview shown inline. A 20,000-character result arrived inline. This confirms the NFR-004 cap of 20,000 characters.
  - **Headless elicitation:** in `-p` mode, the server's `elicitation/create` was answered `cancel` within about 5 ms. No human was involved.
  - **Untested:** the desktop app's embedded client version was not tested separately.
- **Confidence:** High for CLI 2.1.169.
- **Architectural impact:**
  - OQ-02 is closed.
  - Claude Code currently connects using the legacy (2025-11-25) era, so the 2026-07-28-only features are not exercised by this client. Examples are `server/discover`-first negotiation and MRTR elicitation.
  - Both elicitation paths must remain implemented.
- **Follow-up:** Re-run `spikes/disc-001` whenever the pinned Claude Code version changes.

### RL-031 — An elicitation hook can approve without a human (empirical)
- **Source:** Spike `spikes/disc-002`: Claude Code 2.1.169, headless, `--settings` with an `Elicitation` hook (matcher `spike`) whose script prints `{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{"confirm":true}}}`.
- **Source type:** Executed experiment. **Date accessed:** 2026-10-23.
- **Finding:**
  - The server received `action=accept content={"confirm":true}`. No dialog appeared and no human acted.
  - The hook's input contained `hook_event_name`, `mcp_server_name`, `message`, `mode`, `requested_schema`, `session_id`, `cwd` and `transcript_path`.
- **Confidence:** High.
- **Architectural impact:** This turns RL-008 from an inference into an observed result. AL1 stays client-attested only. The default AL1 scope list stays empty for gated actions. OQ-04 is closed.
- **Follow-up:** None.

### RL-032 — Tasks extension in Claude Code
- **Source:** RL-030 handshake capture.
- **Finding:** Claude Code 2.1.169 negotiates the 2025-11-25 era and declares no tasks capability. The `io.modelcontextprotocol/tasks` extension (2026-07-28) is therefore not in use by this client.
- **Confidence:** High for 2.1.169.
- **Architectural impact:** MCP-003 stays conditional and not implemented. OQ-03 is answered: not supported as of 2.1.169.
- **Follow-up:** Re-check when Claude Code adopts the 2026-07-28 era.

### RL-033 — `node:sqlite` evaluation
- **Source:** Spike `spikes/disc-008/bench.mjs`. **Date accessed:** 2026-10-23.
- **Finding:**

  | Check | Node 22.19.0 (SQLite 3.50.4) | Node 24.22.1 (3.53.4) | Node 26.12.1 (3.54.0) |
  |---|---|---|---|
  | WAL mode | ✔ | ✔ | ✔ |
  | `busy_timeout=5000` | ✔ | ✔ | ✔ |
  | Foreign keys enforced | ✔ | ✔ | ✔ |
  | Transaction rollback | ✔ | ✔ | ✔ |
  | 50k inserts in one transaction | 26 ms | 20 ms | 20 ms |
  | Two processes × 2,000 single-row `BEGIN IMMEDIATE` transactions | 4,000 rows, 0 busy errors, `integrity_check=ok` | same | same |
  | `ExperimentalWarning` printed | **yes** | no | no |

- **Confidence:** High for the tested versions.
- **Architectural impact:** ADR-0008 driver decision: use `node:sqlite` behind `SqlPort`, with no native addon. The `better-sqlite3` fallback is not needed. OQ-19 is closed.
- **Follow-up:** STO-002 suppresses or filters the experimental warning only for Node 22 local development, which is outside the support matrix.

### RL-034 — Flutter JSON reporter corpus across versions
- **Source:** Spike `spikes/disc-006/capture.mjs`. Corpora are in `fixtures/flutter-json/<version>/`, with absolute paths scrubbed to `<APP>` and `<HOME>`. **Date accessed:** 2026-10-23.
- **Versions:** 3.38.4 (Dart 3.10.3), 3.38.10 (Dart 3.10.9), 3.41.9 (Dart 3.11.5), 3.47.1 (Dart 3.13.1). The first two are the versions pinned for Autotrader (RL-A01, RL-A02).
- **Finding:**
  - **JSON reporter:** `protocolVersion` was **0.1.1** in all four versions, and the outcome mapping was identical across them.
  - **Flags:**

    | Flag | Status |
    |---|---|
    | `--file-reporter json:<path>`, `--plain-name`, `--coverage-path`, `--timeout`, `--total-shards`, `--update-goldens` | Present in all four versions |
    | `pub get --enforce-lockfile` | Present in all four versions |
    | `--machine` | Present in 3.38.x and 3.41.9. Not shown in 3.47.1's `test --help` |
    | `--no-pub` | Accepted by all four versions, but **not listed** in `flutter test --help --verbose` |

  - **Exit codes:**

    | Scenario | Exit code |
    |---|---|
    | pass, skip | 0 |
    | fail, error, load error, timeout | 1 |
    | **SIGTERM to the process group mid-test** | **0** |

    In the SIGTERM case, `done.success=false` and the running test ended `result: "error"` with **no** `error` event.
  - **Distinguishing signals:**

    | Situation | Signal |
    |---|---|
    | Load error | Non-hidden `testDone` for a test named `loading <path>`, with an `error` event `Failed to load "<path>"` |
    | Timeout | `error` event `TimeoutException after … Test timed out after N seconds.` |
    | Thrown exception | `result: "error"` with an `error` event where `isFailure: false` |
    | Assertion failure | `result: "failure"` |

  - **Dependencies:** Offline `pub get` fails when the pub cache lacks that SDK's pinned packages. When that happens, every test becomes a load error, because the stale package configuration is used.
  - **Side effects:** `flutter test` writes a `build/` directory into the project.
- **Confidence:** High.
- **Architectural impact:**
  - FL-004 must determine the outcome from `done.success` and the events, **never from the exit code alone**.
  - The supervisor, not Flutter's exit code, records whether a run was interrupted.
  - The `prerequisite_missing:pub_get` detection must recognize dependency-resolution failures.
  - Toolchain build outputs in the target repository are expected. This is already documented in the threat model.
- **Follow-up:** Each new Flutter version is added to the corpus by FL-004 tests.

### RL-035 — AL3 approval feasibility on macOS
- **Source:** Spike `spikes/disc-003/al3helper.swift`, run on Xcode 26.4.1, plus OpenSSH 10.3p1. **Date accessed:** 2026-10-23.
- **Finding:**
  - Creating a **persistent** Secure Enclave P-256 key with `.privateKeyUsage | .userPresence` fails from an unsigned or ad-hoc-signed CLI with `-34018` (`errSecMissingEntitlement`).
  - Ad-hoc signing with a `keychain-access-groups` entitlement causes the process to be killed (exit 137), because the entitlement is restricted and requires a provisioning profile.
  - The bundled OpenSSH supports FIDO `ecdsa-sk` key generation, which requires a hardware authenticator. No authenticator was present, so no key was created and no files were written.
- **Confidence:** High for the entitlement behavior. Medium for the FIDO path, which was not run end to end.
- **Architectural impact:** Local AL3 needs one of the following:
  - **(a)** A helper signed with a Developer ID and an embedded provisioning profile granting `keychain-access-groups`. This requires an organization Apple Developer team.
  - **(b)** FIDO2 security keys: `ssh-keygen -Y sign` with `*-sk` keys, where each signature requires a touch. Verification would use `ssh-keygen -Y verify` or a Node verifier.

  The CI AL3 path (PR review) is unaffected. OQ-13 is narrowed and needs an organization decision.
- **Follow-up:** OQ-13. ADR-0006 updated.

### RL-036 — GHES instance version and documented capabilities
- **Sources:**
  - Unauthenticated `GET https://ghe.coxautoinc.com/api/v3/meta`, which returned `installed_version: "3.21.6"` and `verifiable_password_authentication: false`.
  - GHES 3.21 docs:
    - https://docs.github.com/en/enterprise-server@3.21/rest/checks/runs
    - https://docs.github.com/en/enterprise-server@3.21/actions/reference/workflows-and-actions/workflow-syntax
    - https://docs.github.com/en/enterprise-server@3.21/actions/reference/runners/self-hosted-runners
    - https://docs.github.com/en/enterprise-server@3.21/actions/concepts/security/openid-connect
- **Source type:** Primary (instance metadata plus versioned official docs). **Date accessed:** 2026-10-23.
- **Finding:**
  - GHES **3.21.6**.
  - The 3.21 docs document:
    - **Checks API.** Write access is limited to GitHub Apps.
    - **`GITHUB_TOKEN` permissions.** `checks: write` "permits an action to create a check run".
    - **Runners.** Ephemeral (`--ephemeral`) and REST-created JIT runners are supported. The macOS runner supports ARM64.
    - **OIDC.** A conceptual page exists. The truncated permissions table read did not show `id-token`.
- **Confidence:** High for the version and the documented capabilities. **Unverified** for instance configuration: whether Actions is enabled, OIDC is configured, App installation is permitted, and whether the runner pool is ephemeral. No GHES credential was available, since `gh` is authenticated only to github.com.
- **Architectural impact:** ADR-0013 holds for this version. OQ-07 is narrowed to instance configuration.
- **Follow-up:** DISC-005 remainder, with an authorized org account.

## E. Phase 1 tooling findings (2026-10-23)

### RL-037 — Toolchain versions chosen in OPS-001
- **Source:** npm registry metadata (`npm view`), checked on 2026-10-23, plus executed installs and checks in the workspace.
- **Finding:**
  - **TypeScript is pinned to 6.0.3** (released 2026-04-16). `typescript-eslint@8.72.0` declares the peer dependency `typescript >=4.8.4 <6.1.0`, which excludes the latest release, TypeScript 7.0.2 (2026-07-08).
  - **Other dev tools are pinned exactly:** Vitest 5.0.5 (engines `^22.12 || ^24 || >=26`), ESLint 10.13.0, Prettier 3.9.10, `@types/node` 24.19.2 (matching the minimum supported Node line), and Zod 4.6.7 in `@autotest/contracts`.
  - **Install posture:** pnpm 10.19.0 with `strictDepBuilds: true` and an empty `onlyBuiltDependencies` installed all 143 packages without running any dependency build script.
  - **Engine checks:** `engine-strict` rejects Node 22.
  - **Running TypeScript directly:** Node 24 and Node 26 run the TypeScript sources directly through built-in type stripping. Examples are `packages/contracts/scripts/write-schemas.ts` and a contracts-importing script. This works because workspace packages resolve to real paths outside `node_modules`. It requires the erasable-only TypeScript subset, which `tsconfig.base.json` enforces with `erasableSyntaxOnly` and `.ts` import extensions.
  - **Results:** `pnpm check` (typecheck, lint, format, tests) passes on Node 24.22.1 and 26.12.1 with 109 tests.
  - **Update (PLN-002):** `@autotest/planning` adds `markdown-it` 15.0.2 (MIT, released 2026-09-11) as the pinned CommonMark parser the task calls for. 15.0.3 was 7 days old and therefore not chosen. The parser is pure JavaScript with no I/O, which fits the `planning` purity rule.
  - **Update (2026-10-24, OPS-002):** the first CI runs failed only at `pnpm audit --audit-level high --prod`: `markdown-it` 15.0.2 is affected by GHSA-gfr2-rv44-r23c (high, quadratic-time rendering of a multi-line link reference definition) and GHSA-vfgh-jcmw-g37q (low, quadratic-time denial of service). Both are fixed in 15.0.3 (released 2026-10-16), now pinned. The "not younger than two weeks" preference yields to a security fix.
  - **Update (POL-001):** `@autotest/policy` adds `yaml` 2.9.1 (ISC, no dependencies, latest release; registry metadata last modified 2026-09-11) to parse `config.yaml`. It runs restricted: aliases, explicit tags and duplicate keys are rejected. `zod` 4.6.7 is declared there directly as well.
- **Confidence:** High.
- **Architectural impact:**
  - **No build step for development.** REL-001 still decides the packaging for distribution: whether to ship TypeScript sources for Node ≥24 or emit JavaScript.
  - **TypeScript 7 adoption** waits for typescript-eslint support (related to RK-02; tracked in REL-001).
- **Follow-up:** REL-001 packaging decision.

### RL-038 — Distribution packaging: bundling with esbuild
- **Source:** Node.js documentation on type stripping (files under `node_modules` are not stripped: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`); npm registry metadata for `esbuild` (`npm view esbuild time`), checked on 2026-10-23; executed install in the workspace.
- **Finding:**
  - An installed package lives under `node_modules`, so the TypeScript sources cannot be shipped as-is: a JavaScript build is required for distribution.
  - **esbuild 0.28.2** (MIT, released 2026-08-08; the latest release) is pinned as a root devDependency, chosen with the developer on 2026-10-23. It bundles the server, the CLI and the run supervisor into self-contained ESM files, so the release package has no runtime dependencies and no install scripts.
  - esbuild ships its binary as an optional `@esbuild/<platform>` package. Its own postinstall only re-checks that binary, so it is listed under `ignoredBuiltDependencies` and the `strictDepBuilds` posture is unchanged.
- **Confidence:** High.
- **Architectural impact:** Development still runs TypeScript directly; only release builds are bundled (`scripts/build-release.ts`). Code that locates sibling files at run time (the supervisor entry) must resolve both layouts.
- **Follow-up:** REL-001 (remaining release work), SEC-005 (SBOM, provenance).
