// DISC-001 throwaway spike server (MCP TS SDK v2, stdio). Logs only to stderr.
import { McpServer, inputRequired, inputResponse, acceptedContent } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const log = (...a) => process.stderr.write(`[spike] ${a.join(' ')}\n`);
const server = new McpServer({ name: 'autotest-spike', version: '0.0.1' });

const EchoOut = z.object({ echoed: z.string(), length: z.number().int(), node: z.string() });
server.registerTool('spike_echo', {
  title: 'Spike echo',
  description: 'Echo a message back as structured content (DISC-001 spike).',
  inputSchema: z.object({ message: z.string().max(200) }),
  outputSchema: EchoOut,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ message }) => {
  const out = { echoed: message, length: message.length, node: process.version };
  return { content: [{ type: 'text', text: `echoed ${out.length} chars` }], structuredContent: out };
});

server.registerTool('spike_error', {
  description: 'Always returns a tool execution error with a structured error object (DISC-001 spike).',
  inputSchema: z.object({}),
}, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'E_POLICY_DENIED: spike error for testing' }],
  structuredContent: { error: { code: 'E_POLICY_DENIED', message: 'spike error', recoverable: false, nextSteps: [] } },
}));

server.registerTool('spike_big', {
  description: 'Returns a large text result of the requested size in characters (DISC-001 spike).',
  inputSchema: z.object({ chars: z.number().int().min(1).max(200000) }),
}, async ({ chars }) => ({ content: [{ type: 'text', text: 'x'.repeat(chars) }] }));

const Confirm = z.object({ confirm: z.boolean() });
server.registerTool('spike_confirm', {
  description: 'Asks the human to confirm via MCP elicitation (DISC-001/002 spike).',
  inputSchema: z.object({ subject: z.string().max(100) }),
}, async ({ subject }, ctx) => {
  // 2026-07-28 path: answer arrives on retry in inputResponses.
  const raw = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
  if (raw && raw.kind === 'elicit' && raw.action !== 'accept') return { isError: true, content: [{ type: 'text', text: `elicitation ${raw.action}` }] };
  const answered = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', Confirm);
  if (answered) return { content: [{ type: 'text', text: `modern-era answer confirm=${answered.confirm}` }] };
  // 2025-era path: server-initiated elicitation/create.
  try {
    const r = await ctx.mcpReq.elicitInput({ mode: 'form', message: `Confirm ${subject}?`, requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Confirm' } }, required: ['confirm'] } });
    log('legacy elicitation result action=', r.action);
    return { content: [{ type: 'text', text: `legacy-era answer action=${r.action} content=${JSON.stringify(r.content ?? null)}` }] };
  } catch (e) {
    log('elicitInput threw (expected on 2026-07-28):', e?.message ?? e);
    return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: `Confirm ${subject}?`, requestedSchema: Confirm }) } });
  }
});

await server.connect(new StdioServerTransport());
log('ready on', process.version);
