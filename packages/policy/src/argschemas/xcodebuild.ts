/**
 * Argument schema for `xcodebuild` (IOS-003; flags verified on Xcode 26.4.1, RL-017). Only `test` against a project or
 * workspace inside the workspace, one scheme, one simulator destination (`id=<UDID>`), with the result bundle and
 * derived data inside the run directory, and `-only-testing` selections. `-list -json` is the inspection probe.
 * No archive, export, install or build-setting forms exist, so xcodebuild cannot sign, upload or write elsewhere.
 */
import type { ArgSchema } from './types.ts';

const REL = (ext: string) => new RegExp(`^(?!/)(?!.*\\.\\.)[A-Za-z0-9 ._/-]{1,200}\\.${ext}$`);
const SCHEME = /^[A-Za-z0-9 ._-]{1,100}$/;
const DESTINATION = /^id=[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}$/;
/** `Target`, `Target/Class` or `Target/Class/method` (optionally with `()`). */
const TEST_ID = /^[A-Za-z_][A-Za-z0-9_]{0,99}(?:\/[A-Za-z_][A-Za-z0-9_]{0,99}){0,2}(?:\(\))?$/;

export const XCODEBUILD_SCHEMA: ArgSchema = {
  executable: 'xcodebuild',
  forbiddenFlags: ['-exportArchive', '-exportPath', '-allowProvisioningUpdates', '-xcconfig', '-toolchain'],
  forms: [
    {
      id: 'xcodebuild.test',
      class: 'test_runner',
      words: ['test'],
      flags: [
        { name: '-project', value: { kind: 'pattern', pattern: REL('xcodeproj') } },
        { name: '-workspace', value: { kind: 'pattern', pattern: REL('xcworkspace') } },
        { name: '-scheme', value: { kind: 'pattern', pattern: SCHEME } },
        { name: '-destination', value: { kind: 'pattern', pattern: DESTINATION } },
        { name: '-resultBundlePath', value: { kind: 'runPath', prefix: '' } },
        { name: '-derivedDataPath', value: { kind: 'runPath', prefix: '' } },
        { name: '-only-testing', value: { kind: 'pattern', pattern: TEST_ID }, repeatable: true },
      ],
      requiredFlags: ['-scheme', '-destination', '-resultBundlePath'],
    },
    {
      id: 'xcodebuild.list',
      class: 'probe',
      words: [],
      flags: [
        { name: '-list', value: { kind: 'none' } },
        { name: '-json', value: { kind: 'none' } },
        { name: '-project', value: { kind: 'pattern', pattern: REL('xcodeproj') } },
        { name: '-workspace', value: { kind: 'pattern', pattern: REL('xcworkspace') } },
      ],
      requiredFlags: ['-list', '-json'],
    },
  ],
};
