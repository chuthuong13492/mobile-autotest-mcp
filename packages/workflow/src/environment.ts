/**
 * The server's environment id for approval bindings (ADR-0006 §3): `local:<hostId>`. The MCP server and the CLI must
 * derive it identically, or a CLI approval would never match the scope the server checks. `AUTOTEST_HOST_ID`
 * overrides the host name (useful when the host name changes or contains characters the id does not allow).
 */
import os from 'node:os';

export function serverEnvironmentOf(env: Readonly<Record<string, string | undefined>>): { id: string; kind: 'local' } {
  const host = (env['AUTOTEST_HOST_ID'] ?? os.hostname()).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'host';
  return { id: `local:${host}`, kind: 'local' };
}
