/** Detox configuration of the AutoTest React Native fixture (RN-003). Build the apps first (see README.md). */
module.exports = {
  testRunner: {
    args: { $0: 'jest', config: 'e2e/jest.config.js' },
    jest: { setupTimeout: 240000 },
  },
  apps: {
    'ios.release': {
      type: 'ios.app',
      binaryPath: 'ios/build/Build/Products/Release-iphonesimulator/FixtureRn.app',
    },
    'android.release': {
      type: 'android.apk',
      binaryPath: 'android/app/build/outputs/apk/release/app-release.apk',
      testBinaryPath: 'android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk',
    },
  },
  devices: {
    simulator: { type: 'ios.simulator', device: { type: 'iPhone 17e' } },
    attached: { type: 'android.attached', device: { adbName: '.*' } },
  },
  configurations: {
    'ios.sim.release': { device: 'simulator', app: 'ios.release' },
    'android.att.release': { device: 'attached', app: 'android.release' },
  },
};
