/**
 * Argument schema for the `flutter` executable (POL-003). Flags verified against Flutter 3.38–3.47 in DISC-006
 * (research-log RL-034): `--no-pub` is hidden from `--help` but accepted; the JSON file reporter is
 * `--file-reporter json:<path>`.
 */
import type { ArgSchema } from './types.ts';

const INT = /^(0|[1-9]\d{0,3})$/;
/** Dart test tag expressions: identifiers combined with ! && || and parentheses. */
const TAG_EXPR = /^[A-Za-z0-9_\-!&|() ]{1,200}$/;

export const FLUTTER_SCHEMA: ArgSchema = {
  executable: 'flutter',
  forbiddenFlags: [
    '--update-goldens',
    '--start-paused',
    '--enable-vmservice',
    '--host-vmservice-port',
    '--dds-port',
    '--debug-logs-dir',
    '--dart-define-from-file',
  ],
  forms: [
    {
      id: 'flutter.test',
      class: 'test_runner',
      words: ['test'],
      requiredFlags: ['--no-pub'],
      positionalPaths: { pattern: /^(?:[^/]+\/)*[^/]+_test\.dart$/, max: 200 },
      flags: [
        { name: '--no-pub', value: { kind: 'none' } },
        { name: '--file-reporter', value: { kind: 'runPath', prefix: 'json:' } },
        {
          name: '--reporter',
          value: { kind: 'enum', values: ['compact', 'expanded', 'failures-only', 'github', 'json', 'silent'] },
        },
        { name: '--plain-name', value: { kind: 'pattern', pattern: /^.{1,500}$/ }, repeatable: true },
        { name: '--name', value: { kind: 'pattern', pattern: /^.{1,500}$/ }, repeatable: true },
        { name: '--tags', value: { kind: 'pattern', pattern: TAG_EXPR } },
        { name: '--exclude-tags', value: { kind: 'pattern', pattern: TAG_EXPR } },
        { name: '--timeout', value: { kind: 'pattern', pattern: /^(none|\d{1,5}(ms|s|m)|\d{1,2}(\.\d)?x)$/ } },
        { name: '--coverage', value: { kind: 'none' } },
        { name: '--coverage-path', value: { kind: 'runPath', prefix: '' } },
        { name: '--total-shards', value: { kind: 'pattern', pattern: INT } },
        { name: '--shard-index', value: { kind: 'pattern', pattern: INT } },
        { name: '--concurrency', value: { kind: 'pattern', pattern: INT } },
      ],
    },
    {
      id: 'flutter.version',
      class: 'probe',
      words: [],
      requiredFlags: ['--version', '--machine'],
      flags: [
        { name: '--version', value: { kind: 'none' } },
        { name: '--machine', value: { kind: 'none' } },
      ],
    },
    {
      id: 'flutter.pub_get',
      class: 'build_tool',
      words: ['pub', 'get'],
      requiredFlags: ['--enforce-lockfile'],
      gate: 'dependency_resolution',
      flags: [{ name: '--enforce-lockfile', value: { kind: 'none' } }],
    },
  ],
};
