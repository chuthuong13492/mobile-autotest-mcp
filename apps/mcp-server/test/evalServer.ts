/**
 * Eval-only stdio entrypoint (SKL-002): the real server with the GitHub API pointed at a local mock
 * (`AUTOTEST_EVAL_GITHUB_URL`). It is not part of the release bundle; production has no way to redirect GitHub.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { composeServer } from '../src/compose.ts';
import { guardConsole, serverLogTransform } from '../src/log.ts';

const url = process.env['AUTOTEST_EVAL_GITHUB_URL'];
if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
  console.error('AUTOTEST_EVAL_GITHUB_URL must be a local mock (http://127.0.0.1:<port>)');
  process.exit(2);
}
guardConsole(serverLogTransform({ piiSalt: 'eval' }));
const composed = await composeServer({ github: { baseUrl: url } });
process.stdin.once('end', () => void composed.close().then(() => process.exit(0)));
await composed.server.connect(new StdioServerTransport());
