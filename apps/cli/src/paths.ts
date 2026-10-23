/**
 * Where the installed pieces are. In a release bundle (`scripts/build-release.ts` defines `AUTOTEST_BUNDLE`) the
 * server is `autotest-mcp.mjs` next to the CLI bundle and the Skill is in the package's `skills/` folder; from
 * source they are the repository's `apps/mcp-server/src/main.ts` and `skills/`.
 */
import { fileURLToPath } from 'node:url';

declare const AUTOTEST_BUNDLE: boolean | undefined;
const bundled = typeof AUTOTEST_BUNDLE !== 'undefined' && AUTOTEST_BUNDLE;

/** Absolute path of the MCP server entrypoint to register with Claude Code. */
export function serverEntryPath(): string {
  return fileURLToPath(new URL(bundled ? './autotest-mcp.mjs' : '../../mcp-server/src/main.ts', import.meta.url));
}

/** Absolute path of the bundled Skill folder (`pr-mobile-autotest`). */
export function skillSourcePath(): string {
  return fileURLToPath(
    new URL(bundled ? '../skills/pr-mobile-autotest' : '../../../skills/pr-mobile-autotest', import.meta.url),
  );
}
