/**
 * Entrypoint: `autotest-mcp` (stdio). Stdout carries only MCP frames: logs and any console output go to stderr.
 * The server exits when stdin closes or on SIGTERM/SIGINT; run supervisors are detached and keep running.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { guardConsole, serverLogTransform } from './log.ts';
import { composeServer, resolveDataRoot } from './compose.ts';

const restoreConsole = guardConsole(serverLogTransform({ piiSalt: resolveDataRoot(process.env) }));
const composed = await composeServer();
const transport = new StdioServerTransport();

let stopping = false;
const stop = async (reason: string) => {
  if (stopping) return;
  stopping = true;
  composed.logger.info('server.stopping', { data: { reason } });
  await composed.close();
  restoreConsole();
  process.exit(0);
};
process.stdin.once('end', () => void stop('stdin_closed'));
process.once('SIGTERM', () => void stop('sigterm'));
process.once('SIGINT', () => void stop('sigint'));

await composed.server.connect(transport);
composed.logger.info('server.started', { data: { pid: process.pid } });
