# fixture-ios

A minimal native iOS app for the iOS adapter (IOS-001 – IOS-003): a SwiftUI counter, `FixtureAppTests` (two passing
cases, one failing on purpose, one skipped) and `FixtureAppUITests` (one XCUITest). The project file is written by
hand in the Xcode 16+ synchronized-folder format (objectVersion 77); code signing is off, so it runs on simulators
only.

```bash
xcodebuild test -project FixtureApp.xcodeproj -scheme FixtureApp -destination id=<simulator udid> \
  -resultBundlePath /tmp/Test.xcresult
```

Expected: 3 passed, 1 failed, 1 skipped; exit code 65.
