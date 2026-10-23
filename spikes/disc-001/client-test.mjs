// SDK v2 client test against the spike server over stdio (runs on whatever Node executes it).
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('./server.mjs', import.meta.url).pathname], stderr: 'ignore' });
const client = new Client({ name: 'disc-001-client', version: '0.0.1' }, { capabilities: { elicitation: { form: {} } } });
const res = { node: process.version };
await client.connect(transport);
res.protocolVersion = client.getNegotiatedProtocolVersion?.() ?? client.protocolVersion ?? 'unknown';
const tools = await client.listTools(); res.tools = tools.tools.map(t => t.name);
res.echoHasOutputSchema = !!tools.tools.find(t => t.name === 'spike_echo').outputSchema;
const echo = await client.callTool({ name: 'spike_echo', arguments: { message: 'hello' } }); res.echoStructured = echo.structuredContent;
const err = await client.callTool({ name: 'spike_error', arguments: {} }); res.errorIsError = err.isError === true; res.errorStructured = !!err.structuredContent;
const bad = await client.callTool({ name: 'spike_echo', arguments: { message: 123 } }).catch(e => ({ thrown: e.message })); res.invalidInput = bad.thrown ? `thrown: ${bad.thrown.slice(0, 80)}` : `isError=${bad.isError}`;
const big = await client.callTool({ name: 'spike_big', arguments: { chars: 30000 } }); res.bigLen = big.content[0].text.length;
await client.close();
console.log(JSON.stringify(res, null, 1));
