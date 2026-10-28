/** Built-in argument schemas. Config may only register executables that have one (policy cannot be widened by config). */
import { FLUTTER_SCHEMA } from './flutter.ts';
import { GH_SCHEMA } from './gh.ts';
import { ADB_SCHEMA, AVDMANAGER_SCHEMA, EMULATOR_SCHEMA, XCRUN_SCHEMA } from './devices.ts';
import { GIT_SCHEMA } from './git.ts';
import { JAVA_SCHEMA } from './java.ts';
import { NODE_SCHEMA } from './node.ts';
import { MAESTRO_SCHEMA } from './maestro.ts';
import { APPIUM_SCHEMA } from './appium.ts';
import { XCODEBUILD_SCHEMA } from './xcodebuild.ts';
import type { ArgSchema } from './types.ts';

export type { ArgSchema, CommandForm, ExecClass, FlagRule, FlagValue, Positional } from './types.ts';

export const ARG_SCHEMAS: Readonly<Record<string, ArgSchema>> = {
  flutter: FLUTTER_SCHEMA,
  gh: GH_SCHEMA,
  git: GIT_SCHEMA,
  xcrun: XCRUN_SCHEMA,
  adb: ADB_SCHEMA,
  emulator: EMULATOR_SCHEMA,
  avdmanager: AVDMANAGER_SCHEMA,
  xcodebuild: XCODEBUILD_SCHEMA,
  java: JAVA_SCHEMA,
  node: NODE_SCHEMA,
  maestro: MAESTRO_SCHEMA,
  appium: APPIUM_SCHEMA,
};

export { OWNED_DEVICE_NAME } from './devices.ts';
