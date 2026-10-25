# fixture-android

A minimal native Android app (Java, Gradle 9.3.1, AGP 9.1.0) for the Android adapter (AND-001 – AND-004): JUnit unit
tests (two passing, one failing on purpose, one ignored) and two instrumented tests (one passing, one failing on
purpose). The Gradle wrapper jar is Gradle's own (Apache-2.0), taken from the Flutter SDK's cached wrapper.

```bash
./gradlew testDebugUnitTest --console=plain
ANDROID_SERIAL=emulator-5584 ./gradlew connectedDebugAndroidTest --console=plain
```

Create `local.properties` with `sdk.dir=<Android SDK>` first (it is ignored by git).
