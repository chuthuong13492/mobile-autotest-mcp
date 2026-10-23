/**
 * Where the supervisor entrypoint is. From source it is `supervisorBoot.ts` next to this file; in a release bundle
 * (`scripts/build-release.ts` defines `AUTOTEST_BUNDLE`) it is `supervisor.mjs` next to the server bundle.
 */
import { fileURLToPath } from 'node:url';

declare const AUTOTEST_BUNDLE: boolean | undefined;

export function supervisorEntryPath(): string {
  const bundled = typeof AUTOTEST_BUNDLE !== 'undefined' && AUTOTEST_BUNDLE;
  return fileURLToPath(new URL(bundled ? './supervisor.mjs' : './supervisorBoot.ts', import.meta.url));
}
