/**
 * SKL-002 Skill evaluation harness (testing-strategy §6).
 *
 * For each scenario: a fresh Flutter-shaped workspace with the fake runner (`apps/mcp-server/test/runSetup.ts`), the
 * Skill installed as a project skill (`.claude/skills/pr-mobile-autotest`), and the real AutoTest server from
 * source. Headless Claude Code (`claude -p --output-format stream-json`) gets the scenario prompt; only the
 * AutoTest tools, Read/Grep/Glob and the Skill tool are allowed, so any other call (e.g. `Bash autotest approve`)
 * is denied but still visible in the trace. Checks run on the tool-call trace and the final answer:
 *   called:<tool>   order:<a><<b> (first a before first b, when b happens)   final:/re/flags   bash:<text>
 * `required` checks must hold; `forbidden` checks must not. Results go to `evals/skill/results/<stamp>.json`.
 *
 * Usage: node evals/skill/run.ts [scenarioId ...]   (costs model tokens; runs one pass per scenario)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setupRunData } from '../../apps/mcp-server/test/runSetup.ts';

interface Scenario {
  readonly id: string;
  readonly description: string;
  readonly tests: Record<string, string>;
  readonly prompt: string;
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
}
interface Call {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

const ROOT = path.resolve(import.meta.dirname, '../..');
const SERVER = path.join(ROOT, 'apps/mcp-server/src/main.ts');
const tool = (name: string) => name.replace(/^mcp__autotest__/, '');

export function check(spec: string, calls: readonly Call[], final: string): boolean {
  const [kind, ...rest] = spec.split(':');
  const arg = rest.join(':');
  const names = calls.map((c) => tool(c.name));
  if (kind === 'called') return names.includes(arg);
  if (kind === 'order') {
    const [a, b] = arg.split('<') as [string, string];
    const ib = names.indexOf(b);
    if (ib < 0) return true;
    const ia = names.indexOf(a);
    return ia >= 0 && ia < ib;
  }
  if (kind === 'final') {
    const m = /^\/(.*)\/([a-z]*)$/.exec(arg)!;
    return new RegExp(m[1]!, m[2]).test(final);
  }
  if (kind === 'bash') return calls.some((c) => c.name === 'Bash' && String(c.input['command'] ?? '').includes(arg));
  throw new Error(`unknown check ${spec}`);
}

async function runScenario(s: Scenario): Promise<Record<string, unknown>> {
  const f = setupRunData(s.tests);
  const skillDir = path.join(f.ws, '.claude', 'skills', 'pr-mobile-autotest');
  fs.cpSync(path.join(ROOT, 'skills', 'pr-mobile-autotest'), skillDir, { recursive: true });
  const mcp = path.join(f.base, 'mcp.json');
  fs.writeFileSync(
    mcp,
    JSON.stringify({
      mcpServers: {
        autotest: {
          command: process.execPath,
          args: [SERVER],
          env: { AUTOTEST_HOME: f.data, AUTOTEST_HOST_ID: 'eval-host', AUTOTEST_LOG_LEVEL: 'error' },
        },
      },
    }),
  );
  const args = [
    '-p',
    s.prompt,
    '--mcp-config',
    mcp,
    '--strict-mcp-config',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    '80',
    '--allowedTools',
    'mcp__autotest',
    'Read',
    'Grep',
    'Glob',
    'Skill',
  ];
  const started = Date.now();
  const lines: string[] = [];
  const code = await new Promise<number>((resolve) => {
    const p = spawn('claude', args, { cwd: f.ws, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      lines.push(...parts.filter(Boolean));
    });
    const timer = setTimeout(() => p.kill('SIGTERM'), 15 * 60_000);
    p.on('close', (c) => {
      clearTimeout(timer);
      if (buf) lines.push(buf);
      resolve(c ?? -1);
    });
  });
  const calls: Call[] = [];
  let final = '';
  let usage: unknown;
  for (const line of lines) {
    let ev: {
      type?: string;
      message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] };
      result?: string;
      usage?: unknown;
      total_cost_usd?: number;
    };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'assistant')
      for (const c of ev.message?.content ?? [])
        if (c.type === 'tool_use') calls.push({ name: c.name!, input: c.input ?? {} });
    if (ev.type === 'result') {
      final = ev.result ?? '';
      usage = { usage: ev.usage, costUsd: ev.total_cost_usd };
    }
  }
  const required = s.required.map((c) => ({ check: c, ok: check(c, calls, final) }));
  const forbidden = s.forbidden.map((c) => ({ check: c, violated: check(c, calls, final) }));
  return {
    id: s.id,
    exitCode: code,
    seconds: Math.round((Date.now() - started) / 1000),
    calls: calls.map((c) => tool(c.name)),
    // Shell commands the agent attempted (all are denied in the eval), for review.
    bash: calls.filter((c) => c.name === 'Bash').map((c) => String(c.input['command'] ?? '').slice(0, 300)),
    required,
    forbidden,
    passed: required.every((r) => r.ok) && forbidden.every((x) => !x.violated),
    final: final.slice(0, 4000),
    usage,
  };
}

const only = new Set(process.argv.slice(2));
const dir = path.join(import.meta.dirname, 'scenarios');
const scenarios = fs
  .readdirSync(dir)
  .filter((n) => n.endsWith('.json'))
  .sort()
  .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Scenario)
  .filter((s) => only.size === 0 || only.has(s.id));
const results = [];
for (const s of scenarios) {
  const r = await runScenario(s);
  results.push(r);
  console.log(
    `${r['passed'] ? 'PASS' : 'FAIL'}  ${s.id}  (${r['seconds']} s)  calls: ${(r['calls'] as string[]).join(' → ')}`,
  );
}
const out = path.join(import.meta.dirname, 'results');
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, `${JSON.stringify({ skillVersion: '0.2.0', results }, null, 2)}\n`);
console.log(`results: ${file}`);
