# Platform strategies: what can run, when

The canonical source for platform behavior is `docs/platform-adapters.md` in the Mobile AutoTest MCP repository. This page only tells you how to plan with it.

## What each release can execute

This build is v1.0: only the first row runs. Every other row is planned work.

| Platform / level | Earliest release | Host |
|---|---|---|
| Flutter unit and widget tests (`test/**`) | v0.1 | macOS or Linux, no device |
| Flutter `integration_test` | v1.1 | Needs an owned simulator or emulator. iOS needs macOS. |
| Native Android unit tests | v1.1 | Any host with JDK and Android SDK |
| Native Android instrumented tests | v1.1 | Needs an emulator |
| Native iOS (XCTest/XCUITest) | v1.1 | macOS only |
| React Native Jest | v1.2 | Any host |
| React Native Detox or Maestro | v1.2 | Device. iOS needs macOS. |
| Appium suites (optional) | v1.2 | Device, plus pinned Appium and driver versions |

You may still list a case the current release or host cannot run. The server marks it `ineligible:<reason>`, and the report lists it under not run.

## Devices (v1.1+)

- **Listing devices.** Use `list_devices` to see the simulators, emulators and devices available on the host, and whether the host can run them at all.
- **Managing simulators.** Prefer letting `manage_simulator` create a simulator owned by AutoTest, then boot it.
  - These actions are safe because AutoTest owns the device: `create`, `boot`, and `erase` or `delete` of devices it created.
  - Booting, shutting down, erasing or deleting a simulator the user owns requires human approval. Request it through `request_approval` with kind `device_action`.
  - Physical devices are never erased.
- **Running on a device.** Flutter `integration_test` cases and native iOS cases need a device. Create and boot one with `manage_simulator`, then pass its id: `run_tests { devices: [deviceId] }`. Only one device per run, and it must be AutoTest-owned and booted. The run holds the device until its results are imported; delete it afterwards.
- **Before v1.1.** Device actions return `E_CAPABILITY_UNAVAILABLE`.

## Choosing the runner

- Use the platform's native runner wherever it supports the test level.
- Choose Appium only in these cases:
  - an existing Appium suite must be reused
  - one black-box flow must cover both platforms
  - the test needs system dialogs or flows that cross apps
- Never plan device-farm execution. It is not supported.

## Platform-specific planning tips

- **Flutter host tests.**
  - Widget tests can check semantics labels for accessibility coverage.
  - Tests that need platform channels need mocks. A missing mock looks like a setup failure, not a product defect.
- **SDK version conflicts.** If `inspect_project` reports conflicting Flutter versions (for example, `pubspec.yaml` disagrees with the CI config), ask the user which SDK is pinned before running.
- **Private dependencies.** If `run_tests` answers `E_PREREQUISITE_MISSING` (`pub_get`), or a result is `blocked` with `prerequisite_missing:pub_get`, the user must run `flutter pub get` (with any private registry credentials) outside AutoTest. Runs always use `--no-pub`.
- **Result granularity.** Some suites, such as Appium scenarios, report only per scenario or per file. Their results map to every case on that target, and the report states this limitation.
