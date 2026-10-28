# fixture-react-native

The React Native fixture for the React Native and Appium adapters (RN-001 – RN-003, APM-001, E2E-006): a counter app
(React Native 0.88.0, created with `@react-native-community/cli` 20.2.0; Android compileSdk 36) with

- Jest tests (Jest 29.7, from the template): two passing and one component test, one failing and one skipped on purpose;
- Detox 20.51.4 tests in `e2e/` (one passing, one failing on purpose), configurations `ios.sim.release` and
  `android.att.release` in `.detoxrc.js`;
- Maestro flows in `.maestro/` (`counter` passes, `wrong-count` fails on purpose); both platforms use the app id
  `com.fixturern`;
- a pinned Appium suite: `.autotest/appium.json` (Appium 3.4.2, UiAutomator2 8.7.0), `appium/run-scenario.mjs` (plain
  `fetch` to the WebDriver API, no packages), `appium/scenario-list.json` and one spec document in `appium/spec/`.

`node_modules`, `ios/Pods`, the builds and the Android debug keystore are not committed. The device end-to-end tests need them once:

```bash
npm ci
keytool -genkeypair -v -keystore android/app/debug.keystore -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
cd ios && LANG=en_US.UTF-8 pod install && cd ..
xcodebuild -workspace ios/FixtureRn.xcworkspace -scheme FixtureRn -configuration Release -sdk iphonesimulator -derivedDataPath ios/build build
cd android && ./gradlew assembleRelease assembleAndroidTest -DtestBuildType=release && cd ..
APPIUM_HOME=~/.appium-autotest appium driver install uiautomator2@8.7.0
```

Detox on iOS also needs `applesimutils` (Homebrew tap `wix/brew`).
