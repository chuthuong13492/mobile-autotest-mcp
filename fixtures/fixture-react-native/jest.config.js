module.exports = {
  preset: '@react-native/jest-preset',
  // e2e/ holds the Detox tests, which run on a device through Detox.
  testPathIgnorePatterns: ['/node_modules/', '/e2e/'],
};
