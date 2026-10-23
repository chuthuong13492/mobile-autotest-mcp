// Transparent stdio proxy that logs JSON-RPC method names / protocol metadata (no payload bodies) to a file.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const logFile = process.env.SPIKE_PROXY_LOG || new URL('./proxy.log', import.meta.url).pathname;
const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
const note = (dir, line) => { try { const m = JSON.parse(line); const p = m.params || {}; const meta = p._meta || {};
  const rec = { t: new Date().toISOString(), dir, id: m.id ?? null, method: m.method ?? null,
    protocolVersion: p.protocolVersion ?? meta['io.modelcontextprotocol/protocolVersion'] ?? m.result?.protocolVersion ?? null,
    clientInfo: p.clientInfo ?? meta['io.modelcontextprotocol/clientInfo'] ?? null,
    clientCapabilities: p.capabilities ?? meta['io.modelcontextprotocol/clientCapabilities'] ?? null,
    tool: p.name ?? null, resultType: m.result?.resultType ?? null, isError: m.result?.isError ?? null,
    hasStructured: m.result ? 'structuredContent' in m.result : null, error: m.error?.message ?? null };
  fs.appendFileSync(logFile, JSON.stringify(rec) + '\n'); } catch { fs.appendFileSync(logFile, JSON.stringify({ dir, unparsed: line.length }) + '\n'); } };
const pipe = (src, dst, dir) => { let buf = ''; src.on('data', d => { dst.write(d); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) note(dir, l); } }); };
pipe(process.stdin, child.stdin, 'c2s'); pipe(child.stdout, process.stdout, 's2c');
process.stdin.on('end', () => child.stdin.end()); child.on('exit', c => process.exit(c ?? 0));
