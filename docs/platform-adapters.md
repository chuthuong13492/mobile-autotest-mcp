# Platform Adapters

> **Status:** Design baseline of 2026-10-22, updated as adapters land. Implemented in v1.1: Flutter (host and `integration_test`), native iOS and native Android; React Native and Appium are still planned.

**Canonical home for:** the adapter interface, the capability model, per-platform adapter specifications, the native-vs-Appium selection matrix, macOS-only capabilities, and the Autotrader mapping.
**Decisions:** [ADR-0009](architecture-decisions/ADR-0009.md) (capability model and ports), [ADR-0010](architecture-decisions/ADR-0010.md) (Flutter first), [ADR-0011](architecture-decisions/ADR-0011.md) (native vs Appium), [ADR-0014](architecture-decisions/ADR-0014.md) (shell-free execution).

**Verification labels used in this document:**


| Label | Meaning |
|---|---|
| ✅ verified | Confirmed against an official source on 2026-10-22 (research-log ID given) |
| ⚠ to verify | Not yet confirmed. Owned by the named spike task |

Commands are shown as argv arrays to make clear that **no shell is involved**.

## Release scope summary

| Adapter | v0.1 / v0.2 / v1.0 | v1.1 | v1.2 | Experimental / unsupported |
|---|---|---|---|---|
| Flutter | Host unit + widget tests | `integration_test` on simulator/emulator | — | Golden test update mode (`--update-goldens` is never allowed); web; desktop |
| Native Android | Detection only | Gradle unit tests + instrumented tests (emulator / GMD) | — | Physical-device farms |
| Native iOS | Detection only | `xcodebuild test` on simulators + xcresult parsing | — | Physical devices, UI test recording |
| React Native | Detection only | — | Jest (unit/component) + Detox or Maestro E2E | Expo-specific runners (to evaluate) |
| Appium (optional) | — | — | Pinned server+driver; scenario suites | Cloud device farms |

"Detection only" means that `inspect_project` reports the framework and its targets. Those targets are marked `ineligible:capability_missing`.

## Adapter interface

```ts
// packages/adapter-sdk (implemented in ADP-001: src/types.ts)
export interface PlatformAdapter {
  readonly id: string;                       // "flutter" | "android" | "ios" | "react-native" | "appium"
  readonly version: string;                  // adapter semver, recorded in evidence provenance
  detect(ctx: DetectContext): Promise<DetectionResult>;          // static file signals only (+ optional probes via ProbePort)
  capabilities(ctx: DetectContext): Promise<CapabilitySet>;
  inventory(ctx: InventoryContext): Promise<InventoryFragment>;  // bounded reads via WorkspaceReader
  resolveTargets(input: ResolveInput): ResolveResult;            // pure: plan cases -> TestTarget ids
  buildExecution(req: ExecutionRequest): ExecutionSpec[];        // pure: typed specs, NO spawning
  parseResults(outputs: RunnerOutputs): ParseResult;             // pure: NormalizedResult[] + parse diagnostics
  evidenceHints(outputs: RunnerOutputs): EvidenceHint[];         // which files to ingest, kinds
  failureSignals(results: NormalizedResult[], outputs: RunnerOutputs): FailureSignal[];
  cleanupSpecs?(ctx: CleanupContext): ExecutionSpec[];           // e.g. stop an Appium server it started
}

export interface ExecutionSpec {
  executable: LogicalExecutable;             // e.g. "flutter", "xcodebuild", "gradlew", "adb", "npx-jest" — mapped by policy
  args: ArgToken[];                          // typed tokens: {flag:"--file-reporter", value:{kind:"runPath", rel:"runner/flutter.jsonl"}}
  cwd: WorkspaceRelPath;
  envNeeds: EnvNeed[];                       // names only; resolved by policy/secret source
  expectedOutputs: { kind: ArtifactKind; rel: string }[];
  timeoutMs: number;
  cancellation: "process_group" | "graceful_then_group";
  requires: { host: "any" | "macos" | "linux"; device: "none" | "simulator" | "emulator" | "physical" };
}
```

**Ports injected into adapters** (adapters receive no other I/O):

| Port | What it allows |
|---|---|
| `WorkspaceReader` | `readText(rel, maxBytes)`, `list(globs, limits)`, `exists(rel)`. Checked against policy, with no symlink escape. |
| `ProbePort` | `probe(kind)`, where `kind` is an enumerated read-only probe such as `flutter_version`, `xcode_version` or `adb_version`. Executed by `exec` under the `probe` policy class. |

### Capability model

```ts
interface CapabilitySet {
  levels: ("unit"|"widget"|"component"|"integration"|"e2e")[];
  host: { requires: "any"|"macos"|"linux"; available: boolean; reason?: string };
  devices: { needs: "none"|"simulator"|"emulator"|"physical"; available: boolean };
  selection: ("file"|"name"|"tag"|"scheme"|"class"|"scenario")[];   // granularity of target selection
  resultFormats: string[];                   // e.g. ["dart-json-reporter@3", "junit-xml"]
  resultGranularity: "test" | "file";
  cancellation: "process_group" | "graceful_then_group";
  coverage: boolean;
  limitations: string[];
}
```

Eligibility is computed from these capabilities (FR-014). A target is eligible only when every one of the following holds:

- Its level is supported.
- Its host requirement is met.
- Its device need is available.
- Its executable is allowlisted and present.

The contract test kit (ADP-001) requires every adapter to pass all of the following:

- deterministic `buildExecution`
- policy-schema-valid specs
- robust parsing of truncated, malformed and oversized outputs
- `parseResults` never throws
- unknown runner states map to `infra_error` with a diagnostic

**Implemented (ADP-001/002, 2026-10-23).** The interface is in `packages/adapter-sdk/src/types.ts` with the method names above.

- **Ports:** the workspace port is named `AdapterWorkspace`. It is structurally the `@autotest/workspace` reader, because adapters may not import that package.
- **Kit location:** the contract kit is published as `@autotest/adapter-sdk/testing` (`src/testing/contractKit.ts`), together with a small example adapter.
- **Policy check:** adapters cannot import policy, so the kit's policy-schema check takes an injected validator. `packages/execution/test/adapterPolicy.test.ts` runs the kit with the real `validateSpec`.
- **Eligibility:** `eligibilityOf(target, {capabilities, hostOs, executableAvailable, deviceAvailable})` implements FR-014.
- **JUnit mapping:**
  - `failed` with `failureKind: assertion` (or no kind) → `<failure>`
  - other failure kinds, `timed_out` and `infra_error` → `<error>`
  - `skipped`, `blocked`, `cancelled` and `not_run` → `<skipped>`
  - Characters XML 1.0 cannot carry are written as a visible `\xNN` escape.

## Flutter

### Release 1 scope: host unit and widget tests

- **Detection signals:**
  - `pubspec.yaml` with a `flutter:` SDK dependency (confidence 0.9).
  - `lib/main.dart` (+0.05) and a `test/` directory (+0.05).
  - Platform folders `android/`, `ios/`, `web/`, `macos/` are each reported with their own evidence.
- **Supported layouts:**
  - A single-package app.
  - Monorepos with several `pubspec.yaml` files. Each package is a separate detection, and selection is explicit (A-09).
  - Melos is detected (`melos.yaml`) but not orchestrated in v1.0.
- **SDK resolution (FR-007).** The adapter collects versions from:
  - `pubspec.yaml` → `environment.flutter`
  - `.fvmrc` / `.fvm/fvm_config.json`
  - `.tool-versions`
  - CI config hints (configurable patterns, e.g. `bitrise.yml` `FLUTTER_VERSION` variables, workflow `flutter-version`)
  - the `flutter --version --machine` probe ✅ (RL-034). It reports fields including `frameworkVersion`, `dartSdkVersion` and `flutterRoot`.

  If the sources disagree, the adapter reports a conflict and does not pick one. Execution uses the explicitly configured SDK path. When FVM is configured, that path is the FVM-managed SDK for the project. When neither is set, execution uses the allowlisted `flutter`. The version used is recorded in provenance.
- **Test discovery:**
  - `test/**/*_test.dart` gives levels `unit`/`widget`. Classification is a heuristic: a file is `widget` when it contains `testWidgets(` (bounded scan ≤ 256 KiB per file), and `unit` otherwise.
  - `integration_test/**/*_test.dart` gives level `integration` (v1.1).
  - Helpers: `test/flutter_test_config.dart` (global config), `test/mocks/**`, `test/helpers/**`, `test/fixtures/**`.
  - Tags come from `dart_test.yaml` where present.
- **Selection.** By file path (primary). By test name with `--plain-name` ✅ (RL-014) when the plan selector is a name. By tags with `--tags` / `--exclude-tags` ✅.
- **Command construction (host):**

  ```text
  ["flutter", "test", "--no-pub", "--file-reporter", "json:<runDir>/attempts/<n>/runner/flutter.jsonl", "--reporter", "expanded", <...relative test paths>]
  ```

  - With coverage: add `"--coverage", "--coverage-path", "<runDir>/attempts/<n>/runner/lcov.info"` ✅ (RL-014).
  - `--no-pub` is used by default so that no network dependency resolution happens during runs (SR-014). It is ✅ accepted by 3.38.4, 3.38.10, 3.41.9 and 3.47.1, but not listed in `--help` (RL-034). FL-003 therefore needs a regression test per Flutter version.
  - If the dependencies are not resolved, the run is `blocked` with reason `prerequisite_missing:pub_get`. Policy may permit an explicit prepare step, `flutter pub get --enforce-lockfile` (✅ RL-034), which is allowed only when `allowDependencyResolution: true`.
  - `--update-goldens` is **never** allowed. It is forbidden by the argument schema.
  - `--concurrency` and `--total-shards`/`--shard-index` ✅ are available for CI sharding (CI-002).
- **Prerequisites:**
  - The Flutter SDK is installed.
  - Dependencies are resolved: `.dart_tool/package_config.json` exists and is newer than `pubspec.lock`.
  - Private hosted packages need credentials outside AutoTest. Autotrader's Artifactory dependency is an example (RL-A16).
- **Result format.** The Dart JSON reporter protocol ✅ (RL-015) is mapped as follows:

  | Runner signal | Normalized outcome |
  |---|---|
  | `testDone.result == "success"` and `!skipped` and `!hidden` | `passed` |
  | `testDone.skipped == true` | `skipped` |
  | `testDone.result == "failure"` | `failed` (`failureKind: assertion`) |
  | `testDone.result == "error"` | `failed` (`failureKind: exception`); the analysis decides the class |
  | `error` event after `testDone` | upgrade to `failed` (per the protocol) |
  | Suite load error (an `error` on a loading test) | `failed` (`failureKind: load_error`) for every target in that file |
  | `done.success == null` / runner exit with no `done` | remaining tests → `infra_error`; attempt diagnostic `runner_incomplete` |
  | `hidden == true` | ignored (setUpAll/tearDownAll/loading), unless it errors |

  **Phase 0 corpus findings ([RL-034](research-log.md#rl-034--flutter-json-reporter-corpus-across-versions)):**

  - JSON protocol 0.1.1 is stable across 3.38.4 to 3.47.1.
  - **A run interrupted by SIGTERM exits 0.** In that case `done.success=false`, and the running test ends `error` with no `error` event. The outcome is therefore taken from `done.success` and the events, never from the exit code. The supervisor records interruptions itself.
  - A load error appears as a non-hidden `testDone` for the `loading <path>` test, together with an error event `Failed to load`.
  - A timeout appears as an error event `TimeoutException after … Test timed out`.
  - When offline dependency resolution fails, every test becomes a load error. That pattern maps to `prerequisite_missing:pub_get`, not to a test failure.

  The adapter writes JUnit XML itself with the `adapter-sdk` writer (ADP-002), so it does not depend on stale converters ([RL-016](research-log.md#rl-016--junit-conversion-package-for-flutter)). The protocol version from the `start` event is recorded in provenance.
- **Evidence.** `flutter.jsonl`, `junit.xml`, `stdout.log`, `stderr.log`, `lcov.info` (optional). Widget tests do not produce screenshots unless the tests write them. Files written by tests under the run dir are collected only if they appear in `expectedOutputs`.
- **Failure normalization signals:**

  | Signal | Indicates |
  |---|---|
  | `TestFailure` | assertion |
  | Exception types such as `MissingPluginException` | `environment_failure/dependency` or `test_defect/setup` |
  | `Bad state: No element` | `test_defect/assertion` candidate |
  | Compilation errors (`Error: ` lines with file:line in stderr while loading) | `load_error` |
  | Timeouts | `TimeoutException` / runner `--timeout` |

- **Timeout and cancellation.** The per-test timeout uses `--timeout <N>s` ✅. Cancellation sends SIGTERM to the process group, then SIGKILL. Flutter spawns child test processes (`flutter_tester`). They are in the same group, so they are killed with it.
- **Unsupported in Release 1:**
  - integration tests on devices
  - web and desktop targets
  - golden updates
  - `flutter drive`
  - Patrol ([RL-014](research-log.md#rl-014--flutter-flutter-test-reporting-options): a later option)
- **Security restrictions:**
  - `--update-goldens`, `--start-paused`, `--enable-vmservice`-style debug flags and `pub` subcommands are excluded from the argument schema, apart from the optional, gated `pub get`.
  - Test paths must canonicalize inside the workspace.
- **Validation / fixtures.**
  - DISC-006 captures a JSON corpus from Flutter 3.38.x covering: pass, fail, error, skip, load error, timeout, and an interrupted run.
  - E2E-001 is the synthetic public fixture app. It contains deterministic pass/fail/error/skip tests and a flaky test controlled by a counter file in the run's `TMPDIR`.
- **Local prerequisites (Mac or Linux).** Flutter SDK. Resolved dependencies.
- **CI prerequisites.** A Linux runner is sufficient. Cache the Flutter SDK and `~/.pub-cache`.
- **Known failure modes:**
  - SDK version mismatch
  - stale `.dart_tool`
  - plugins requiring platform channels in widget tests (missing mocks)
  - a global `flutter_test_config.dart` that requires environment setup

### Flutter `integration_test` (v1.1, FL-006)

- Command: `["flutter", "test", "--no-pub", "-d", "<deviceId>", "--file-reporter", "json:<runDir>/attempts/<n>/runner/flutter-device.jsonl", "--reporter", "expanded", "integration_test/<file>"]` ✅ (FL-006, Flutter 3.47 on an iOS 26.4 simulator and an API 36 emulator).
- Inventory: one target per platform (selector `ios` or `android`); a plan case picks the target of its platform.
- Requirements:
  - a booted, run-owned simulator or emulator (`devices` lease)
  - macOS for iOS targets
  - Linux CI needs `xvfb-run` for desktop targets (out of scope)
- Screenshots come from the test's own binding calls, or from `xcrun simctl io <udid> screenshot` / `adb exec-out screencap -p` on failure, run by the supervisor as allowlisted probe-class commands. These commands are ⚠ not implemented yet (failure screenshots are a v1.1 limitation).

## Native Android

Scope: v1.1.

- **Detection signals:** `settings.gradle(.kts)` (workspace root or one level down) whose `include` statements name a module whose build file applies `com.android.application`/`com.android.library` (or the `android.application`/`android.library` plugin aliases), and a Gradle wrapper jar. A Flutter project's `android/` is left to the Flutter adapter (AND-002).
- **Discovery:**
  - `src/test/**` → `unit` (JUnit). `src/androidTest/**` → `integration` (instrumented).
  - One target per JUnit class (the top-level class named like its file, with `@Test` methods; abstract classes skipped).
  - Only the `debug` variant is run. A module with `productFlavors` is reported (`android_product_flavors`) and not inventoried; `projectDir` overrides in settings are reported and not followed. Gradle is **not** run for discovery, because doing so would execute build scripts (T-02).
- **Selection:**
  - Unit tests: `--tests <pattern>` ✅ (RL-018).
  - Instrumented tests: the `connected<Variant>AndroidTest` task with `--project-prop android.testInstrumentationRunnerArguments.class=<Class>,…` (AND-004). `adb shell am instrument` ✅ (RL-018) is not used.
- **Commands (AND-003/004).** The configured JDK (`java`, registered by `autotest setup` from `JAVA_HOME`) runs the project's wrapper jar; the repository's `gradlew` shell script is never executed and is not an allowlisted executable:
  - `["java", "-classpath", "<ws>/gradle/wrapper/gradle-wrapper.jar", "org.gradle.wrapper.GradleWrapperMain", ":app:testDebugUnitTest", "--rerun", "--tests", "<Class>", …, "--offline", "--no-daemon", "--console=plain"]` ✅ (Gradle 9.3.1, AGP 9.1.0)
  - `[…, ":app:connectedDebugAndroidTest", "--project-prop", "android.testInstrumentationRunnerArguments.class=<Class>,…", "--offline", "--no-daemon", "--console=plain"]` ✅; the emulator is chosen by `ANDROID_SERIAL`, which the supervisor sets from the run's device lease (argv never carries a serial).
  - The `java` argument schema allows only that classpath (first token), that main class, one test task, and the flags above. Init scripts, other build or settings files, system properties, arbitrary project properties, daemons and online builds are refused. `--rerun` forces the unit-test task to run, so its report is never stale.
  - The build scripts are repository code. This is an inherent risk (T-02), mitigated by the policy class `test_runner`, the minimal environment and offline mode. Gradle can still read `GRADLE_USER_HOME/gradle.properties`.
- **Prerequisites:** JDK, Android SDK (`ANDROID_HOME`), an emulator image or GMD for instrumented tests.
- **Result formats.** JUnit XML under `<module>/build/test-results/` (unit) and `<module>/build/outputs/androidTest-results/connected/` (instrumented) ✅ (RL-018). Subfolders are discovered recursively because they vary by variant and AGP version; AGP 9.1.0 verified ✅ (AND-001, RL-018). Gradle cannot write them elsewhere, so the spec's `collect` entries make the supervisor copy the files written since the spawn into `attempts/<n>/runner/` (no symlinks followed, capped). The reader decodes only predefined and numeric entities; a build failure without a report becomes `load_error` with Gradle's "What went wrong" text.
- **Evidence:** JUnit XML and AGP's per-test logcat files (`logcat-<Class>-<method>.txt`), copied by `collect`. Failure screenshots are not captured yet.
- **Failure signals:**
  - Gradle daemon or OOM → `environment_failure/toolchain`
  - `INSTALL_FAILED_*` → `environment_failure/device`
  - assertion stack traces → test or product
  - `Process crashed` → product or `unknown`
- **CI.** Linux works for unit tests. Instrumented tests on Linux need KVM, or GMD with `swiftshader_indirect` (RL-019, medium confidence).
- **Limitations.** Gradle configuration time. Build-script execution risk. Emulator flakiness.

## Native iOS

Scope: v1.1. Requires macOS.

- **Detection signals:** `*.xcworkspace` / `*.xcodeproj`, `Package.swift`, test targets (`*Tests` folders, `.xctestplan`). In Flutter repos, `ios/Runner.xcodeproj`.
- **Discovery.** Shared schemes are read statically from `xcshareddata/xcschemes/*.xcscheme` (testables, skipped ones excluded), product types from `project.pbxproj`, and one target per `XCTestCase` class (IOS-002). `.xctestplan` files are not read yet. `xcodebuild -list -json` may be used as an allowlisted probe ✅ (IOS-001). A Flutter project's `ios/` is left to the Flutter adapter.
- **Selection.** By scheme and test plan, and by `-only-testing:<Target>/<Class>/<method>` ✅ (IOS-001, repeatable).
- **Command:**

  ```text
  ["xcodebuild", "test", "-workspace|-project", <path>, "-scheme", <scheme>, "-destination", "id=<udid>", "-resultBundlePath", "<runDir>/attempts/<n>/runner/Test.xcresult"]
  ```

  Verified on Xcode 26.4.1 ✅ (IOS-001, RL-017); exit code 65 covers both test and build failures, so `get build-results` tells them apart.
- **Result parsing.** `xcrun xcresulttool get test-results summary --path <bundle> --compact` ✅ (medium confidence, RL-017). Per-test detail uses `get test-results tests` ✅ (IOS-001: node tree with `result` and `Failure Message` children; use `durationInSeconds`, the `duration` string is locale-formatted). IOS-003 runs `get test-results tests` and `get build-results` after each `xcodebuild test` and parses their stdout; build errors become `load_error`. Only Xcode 26.4.1 is verified; there is no version probe or `--legacy` fallback yet.
- **Evidence:**
  - The `.xcresult` bundle (kept as a directory artifact, excluded from publication)
  - extracted failure attachments and screenshots (after redaction, where the format allows)
  - coverage via `xcrun xccov` (optional)
- **Failure signals:**
  - simulator boot failures → `environment_failure/device`
  - code signing → `environment_failure/toolchain`
  - test runner crash, or `Test crashed with signal` → `unknown` or product
  - XCTest assertion failures
- **Prerequisites.** Xcode matching the project. Simulator runtimes. Autotrader's Bitrise stack uses Xcode 26.3 (RL-A08).
- **Limitations:**
  - macOS only
  - slow builds
  - the result-bundle schema is not published (RK-07)
  - physical devices are out of scope

## React Native

Scope: v1.2 (implemented: RN-001 – RN-003; `packages/adapter-react-native`).

- **Detection signals:**
  - `package.json` with a `react-native` dependency
  - `app.json` / `metro.config.js`
  - the `ios/` and `android/` folders
  - Expo (`expo` dependency) is detected and flagged
- **Discovery:**
  - Jest tests (`__tests__/**`, `*.test.(t|j)sx?`) → `unit`/`component`. A file is `component` when it imports `@testing-library/react-native`.
  - Detox configs (`.detoxrc*`) and Maestro flows (`.maestro/**/*.yaml`) → `e2e`.
- **Commands** (all ✅, RN 0.88.0 fixture, Jest 29.7, Detox 20.51.4, Maestro 2.11.0):
  - Jest: `["node", "<ws>/node_modules/jest/bin/jest.js", "--ci", "--json", "--outputFile", "<runDir>/…/jest.json", "--testLocationInResults", "--no-watchman", "--runTestsByPath", <files>]`. The configured Node runs the workspace's own Jest as its first argument; `npx` is never used (SR-014).
  - Maestro: `["maestro", "test", "--udid", <UDID|emulator-port>, "--format", "JUNIT", "--output", "<runDir>/…/maestro.xml", "--test-output-dir", "<runDir>/…/maestro", "--no-ansi", <flows>]`, with `MAESTRO_CLI_NO_ANALYTICS=1` fixed by policy. The app must be installed on the device first: `manage_simulator {action: "install"}` installs a `.app`/`.apk` built beforehand from an allowlisted workspace, on AutoTest-owned devices only.
  - Detox: `["node", "<ws>/node_modules/detox/local-cli/cli.js", "test", "--config-path", "<runDir>/…/detox.config.js", "--configuration", <name>, …, "--json", "--outputFile", "<runDir>/…/detox.json", <e2e files>]`. Detox's `--device-name` selects iOS simulators by type only (it could pick a device AutoTest does not own), so the run writes a config (ExecutionSpec `files`) that extends the project's config and pins the configuration to the run's device (`{id: <UDID>}` on iOS, `{adbName: <serial>}` on Android). On iOS, Detox's framework cache lives in HOME, which is per run, so `build-framework-cache` runs first. `detox build` (a shell command from the project) is not allowed: build the app beforehand. Detox starts `jest` by name, so `<ws>/node_modules/.bin` is appended to the end of PATH for that form only.
- **Results:**
  - Jest JSON is parsed directly; it could also go through a JUnit reporter if one is configured.
  - Maestro produces JUnit.
  - Detox produces Jest-based output.
- **Prerequisites.** Node and the package manager's installed `node_modules`. AutoTest does not install them unless policy allows. Simulators and emulators for E2E.
- **Limitations.**
  - JS test code runs with Node privileges (T-02).
  - Detox requires matching native builds.
  - New Architecture support is not covered in the Detox release notes that were read (RL-020).

## Appium

Optional, v1.2 (implemented: APM-001, APM-002 mapping; `packages/adapter-appium`).

- **Purpose:** reuse existing Appium suites, such as Autotrader's scenarios, or run cross-platform black-box flows ([ADR-0011](architecture-decisions/ADR-0011.md)).
- **Detection signals:**
  - `appium` or `webdriverio` in a JS `package.json`
  - the `appium_flutter_server` dev dependency
  - `integration_test/appium_test.dart`
  - scenario registries
- **Version pinning (mandatory).** The workspace file `.autotest/appium.json` declares `serverVersion`, `drivers[{name, version}]`, the port (4723 – 4799), the platforms, the runner script and the scenario source (a JSON list or a registry with `case "name":` labels). Before a run is created and again at dispatch, the adapter probes `appium --version` and `appium driver list --installed --json` ✅ (APM-001; `APPIUM_HOME` comes from `env.allow`) and refuses the run on any difference (`prerequisite_mismatch`). Without the file a suite is inventoried but never runs (`appium:not_pinned`).
- **Execution.** The Appium server (`appium server --address 127.0.0.1 --port <port> --log <runDir>/…`) runs as a background service of the attempt (ExecutionSpec `background`): the supervisor waits for "Appium REST http interface listener started", runs one `node <runner> --scenario <name> [--udid <device>] [--port <port>] --platform <p>` per scenario, and terminates the server's process group at the end of the attempt or on cancel. Insecure features, plugins, other configs and driver installs cannot be passed.
- **Results.** Many existing suites only emit exit codes and logs. Autotrader's suite emits `status code: N` lines and TSV ([RL-A12](research-log.md#b-autotrader-reference-repository-read-only-inspection-2026-10-22)). The adapter maps exit code 0 to `passed` and any other exit code to `failed` (`failureKind: crash` when no assertion marker is found). The granularity is the **scenario** level, recorded as a limitation.
- **Limitations.** It is slow and flaky, and it needs devices. Cloud farms are not supported.

## Native vs Appium selection matrix

| Situation | Choose | Reason |
|---|---|---|
| Unit, widget or component tests on any platform | Native runner | Fast, host-capable, precise results |
| Flutter in-app flows | `flutter test integration_test` | Same runner, structured output |
| Existing Appium suite to reuse | Appium adapter | Avoids rewriting the suite |
| One script must drive iOS and Android black-box | Appium | Single driver |
| RN E2E, greenfield | Maestro (JUnit) or Detox | RN docs recommendations (RL-020) |
| Native UI tests in Xcode/Gradle | Native runner | Results in xcresult/JUnit |
| Needs system dialogs or cross-app flows | Appium or native UI test frameworks | Native in-process frameworks cannot reach them |

## Capabilities that require macOS

| Capability | Requires macOS | Linux alternative |
|---|---|---|
| Flutter host unit and widget tests | no | ✔ Linux |
| Flutter `integration_test` on an iOS simulator | **yes** | none |
| Flutter `integration_test` on an Android emulator | no (needs KVM on Linux) | ✔ with KVM / GMD |
| `xcodebuild`, `xcresulttool`, `simctl`, iOS simulators | **yes** | none |
| Android Gradle unit tests | no | ✔ |
| Android instrumented tests | no | ✔ with emulator acceleration |
| RN Jest | no | ✔ |
| Detox/Maestro iOS | **yes** | none |
| Appium XCUITest driver | **yes** | none |

## Autotrader mapping (reference profile, not a compatibility guarantee)

| Autotrader asset (RL-A*) | Adapter handling | Release |
|---|---|---|
| 725 unit and widget test files under `test/` | Flutter host targets. `flutter_test_config.dart` is recognized as global config | v0.2 acceptance (credential-gated, E2E-003) |
| Flutter version drift 3.38.4 vs 3.38.10; `.fvmrc` gitignored | Conflict reported. The user pins the SDK in config | v0.1 |
| `--reporter=github` used in CI | AutoTest uses `--file-reporter json:` alongside the existing CI reporter | v0.2 |
| Private Artifactory and GHE SSH dependencies | `prerequisite_missing:pub_get` unless resolved beforehand | v0.2 |
| `integration_test/appium_test.dart` + TS WebdriverIO suite, 27 scenarios | Appium adapter, scenario granularity, version pinning required | v1.2, after OQ-06 and OQ-14 |
| Spec files `integration_test/spec/**` (Intention/Preconditions/Flow/Expected Outcome) | Optional link: a scenario-to-spec mapping by kebab/camel name conversion (APM-002), used to enrich test-case text | v1.2 |
| LambdaTest remote execution | Out of scope (device farm) | — |
| `marionette_mcp` live control | Not an adapter in v1.x. A possible exploratory driver (OQ-11) | — |
