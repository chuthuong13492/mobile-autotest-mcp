/** Built-in argument schemas. Config may only register executables that have one (policy cannot be widened by config). */
import { FLUTTER_SCHEMA } from './flutter.ts';
import { GH_SCHEMA } from './gh.ts';
import { GIT_SCHEMA } from './git.ts';
import type { ArgSchema } from './types.ts';

export type { ArgSchema, CommandForm, ExecClass, FlagRule, FlagValue, Positional } from './types.ts';

export const ARG_SCHEMAS: Readonly<Record<string, ArgSchema>> = {
  flutter: FLUTTER_SCHEMA,
  gh: GH_SCHEMA,
  git: GIT_SCHEMA,
};
