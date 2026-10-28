/**
 * Argument schema for `node` running a repository's own test runner (RN-002/003; verified with Jest 29.7 and Detox
 * 20.51.4, RL-020). The configured Node runs the workspace's `node_modules/jest/bin/jest.js` or
 * `node_modules/detox/local-cli/cli.js` as the first argument, so no Node option can be passed and `npx` (which may
 * fetch packages) is never used (SR-014). Jest gets JSON output into the run directory, CI mode, no watchman and
 * explicit test file paths. Detox may only build its framework cache (into the run's HOME) or `test` one
 * configuration with a config file from the run directory (the device pin, RN-003); `detox build`, which runs the
 * project's shell build command, is not allowed. The runners and the tests are repository code (T-02).
 */
import type { ArgSchema } from './types.ts';

const DETOX = /^(?:[A-Za-z0-9._@-]{1,100}\/){0,3}node_modules\/detox\/local-cli\/cli\.js$/;
/** APM-001: a scenario runner script of the workspace (JavaScript, outside node_modules). */
const SCENARIO_SCRIPT =
  /^(?!.*(?:^|\/)node_modules\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@-]{1,100}(?:\/[A-Za-z0-9._@-]{1,100}){0,10}\.(?:js|mjs|cjs)$/;
const SCENARIO = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const DEVICE = /^(?:[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}|emulator-\d{4,5})$/;
const JEST = /^(?:[A-Za-z0-9._@-]{1,100}\/){0,3}node_modules\/jest\/bin\/jest\.js$/;
const TEST_FILE =
  /^(?!.*(?:^|\/)node_modules\/)[A-Za-z0-9 ._@()[\]-]{1,200}(?:\/[A-Za-z0-9 ._@()[\]-]{1,200}){0,20}\.(?:js|jsx|ts|tsx|mjs|cjs)$/;

export const NODE_SCHEMA: ArgSchema = {
  executable: 'node',
  forbiddenFlags: [
    '--config',
    '-c',
    '--rootDir',
    '--setupFiles',
    '--globalSetup',
    '--reporters',
    '--testResultsProcessor',
    '--watch',
    '--watchAll',
    '--updateSnapshot',
    '-u',
    '--require',
    '-r',
    '--eval',
    '-e',
    '--import',
    '-C',
    '--repl',
    '--inspect-brk',
    '--device-boot-args',
    '--app-launch-args',
    '--reuse',
  ],
  forms: [
    {
      id: 'node.jest',
      class: 'test_runner',
      script: JEST,
      words: [],
      flags: [
        { name: '--ci', value: { kind: 'none' } },
        { name: '--json', value: { kind: 'none' } },
        { name: '--outputFile', value: { kind: 'runPath', prefix: '' } },
        { name: '--testLocationInResults', value: { kind: 'none' } },
        { name: '--runTestsByPath', value: { kind: 'none' } },
        { name: '--no-watchman', value: { kind: 'none' } },
        { name: '--coverage', value: { kind: 'none' } },
        { name: '--coverageDirectory', value: { kind: 'runPath', prefix: '' } },
      ],
      requiredFlags: ['--ci', '--json', '--outputFile', '--runTestsByPath'],
      positionalPaths: { pattern: TEST_FILE, max: 500 },
    },
    {
      // APM-001: one Appium scenario per process; the suite connects to the run's Appium server and device.
      id: 'node.scenario',
      class: 'test_runner',
      script: SCENARIO_SCRIPT,
      words: [],
      flags: [
        { name: '--scenario', value: { kind: 'pattern', pattern: SCENARIO } },
        { name: '--udid', value: { kind: 'pattern', pattern: DEVICE } },
        { name: '--port', value: { kind: 'pattern', pattern: /^47(?:2[3-9]|[3-9][0-9])$/ } },
        { name: '--platform', value: { kind: 'enum', values: ['ios', 'android'] } },
      ],
      requiredFlags: ['--scenario'],
    },
    {
      id: 'node.detox.framework',
      class: 'test_runner',
      script: DETOX,
      words: ['build-framework-cache'],
      flags: [],
      requiredFlags: [],
    },
    {
      id: 'node.detox.test',
      class: 'test_runner',
      script: DETOX,
      cwdPathDirs: ['node_modules/.bin'],
      words: ['test'],
      flags: [
        { name: '--config-path', value: { kind: 'runPath', prefix: '' } },
        { name: '--configuration', value: { kind: 'pattern', pattern: /^[A-Za-z0-9._-]{1,64}$/ } },
        { name: '--artifacts-location', value: { kind: 'runPath', prefix: '' } },
        { name: '--record-logs', value: { kind: 'enum', values: ['failing', 'all', 'none'] } },
        { name: '--take-screenshots', value: { kind: 'enum', values: ['failing', 'all', 'none'] } },
        { name: '--headless', value: { kind: 'none' } },
        { name: '--json', value: { kind: 'none' } },
        { name: '--outputFile', value: { kind: 'runPath', prefix: '' } },
      ],
      requiredFlags: ['--config-path', '--configuration'],
      positionalPaths: { pattern: TEST_FILE, max: 500 },
    },
  ],
};
