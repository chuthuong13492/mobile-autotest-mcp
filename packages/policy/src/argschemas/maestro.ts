/**
 * Argument schema for the Maestro CLI (RN-003; verified with Maestro 2.11.0). Only `test` of flow files under
 * `.maestro/` in the workspace, on one simulator (UDID) or emulator (`emulator-<port>`), with the JUnit report and the
 * debug output inside the run directory. Cloud upload, AI analysis, API keys, flow environment values and other
 * configuration files cannot be passed; analytics and notices are switched off through the fixed environment.
 */
import type { ArgSchema } from './types.ts';

const DEVICE = /^(?:[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}|emulator-\d{4,5})$/;
const FLOW =
  /^(?:[A-Za-z0-9._-]{1,100}\/){0,3}\.maestro\/(?:[A-Za-z0-9 ._-]{1,100}\/){0,10}[A-Za-z0-9 ._-]{1,100}\.ya?ml$/;

export const MAESTRO_SCHEMA: ArgSchema = {
  executable: 'maestro',
  env: { MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true' },
  forbiddenFlags: [
    '--api-key',
    '--api-url',
    '--analyze',
    '--config',
    '-e',
    '--env',
    '--continuous',
    '-c',
    '--shard-all',
    '--shard-split',
    '-s',
    '--shards',
  ],
  forms: [
    {
      id: 'maestro.test',
      class: 'test_runner',
      words: ['test'],
      flags: [
        { name: '--udid', value: { kind: 'pattern', pattern: DEVICE } },
        { name: '--format', value: { kind: 'enum', values: ['JUNIT'] } },
        { name: '--output', value: { kind: 'runPath', prefix: '' } },
        { name: '--test-output-dir', value: { kind: 'runPath', prefix: '' } },
        { name: '--no-ansi', value: { kind: 'none' } },
      ],
      requiredFlags: ['--udid', '--format', '--output'],
      positionalPaths: { pattern: FLOW, max: 200 },
    },
  ],
};
