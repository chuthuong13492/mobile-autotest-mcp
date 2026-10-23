/**
 * `autotest setup` (M7, part of REL-001): one command that makes a machine ready.
 *
 * 1. Host checks (Node 24+, node:sqlite, ps); stop on a failure.
 * 2. `init` (data root 0700 and a commented config 0600; an existing config is kept).
 * 3. Optional: add `--workspace <path>` entries and the Flutter SDK (`--flutter <path>`, or a single SDK found by
 *    `doctor --suggest-executables`, or a choice when interactive) to `config.yaml`, preserving its comments.
 * 4. Register the MCP server with Claude Code at user scope: `claude mcp add --scope user autotest -- <node> <server>`
 *    using the absolute path of the Node running this command (so a different `node` on PATH cannot break it).
 *    Without the `claude` CLI, print the JSON to add by hand.
 * 5. Copy the Skill to `~/.claude/skills/pr-mobile-autotest`.
 * 6. Print (never write) the recommended Claude Code deny rules, then a doctor summary.
 * `autotest uninstall-claude` removes what steps 4 and 5 added.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeExecPort } from '@autotest/exec';
import { isMap, isSeq, parseDocument } from 'yaml';
import { dataRootOf, type CliEnv } from '../context.ts';
import type { Io } from '../io.ts';
import { serverEntryPath, skillSourcePath } from '../paths.ts';
import { doctorChecks, hostChecks, suggestFlutter } from './doctor.ts';
import { init } from './init.ts';

export const DENY_RULES = [
  'Bash(autotest approve*)',
  'Bash(autotest revoke*)',
  'Edit(~/.autotest/**)',
  'Write(~/.autotest/**)',
  'Bash(*~/.autotest*)',
];

export interface SetupFlags {
  readonly yes: boolean;
  readonly workspaces: readonly string[];
  readonly flutter?: string;
  readonly skipClaude: boolean;
}

export function parseSetupFlags(args: readonly string[]): SetupFlags | undefined {
  const workspaces: string[] = [];
  let flutter: string | undefined;
  let yes = false;
  let skipClaude = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--yes') yes = true;
    else if (a === '--skip-claude') skipClaude = true;
    else if ((a === '--workspace' || a === '--flutter') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      if (a === '--workspace') workspaces.push(args[++i]!);
      else flutter = args[++i]!;
    } else return undefined;
  }
  return { yes, workspaces, ...(flutter ? { flutter } : {}), skipClaude };
}

/** `ws_<name>` from a folder name, unique among existing ids. */
export function workspaceId(dir: string, taken: ReadonlySet<string>): string {
  const base = `ws_${
    path
      .basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'app'
  }`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

/** Adds workspaces and the flutter executable to config.yaml, keeping comments. Returns what changed. */
export function updateConfig(file: string, add: { workspaces: readonly string[]; flutter?: string }): string[] {
  const doc = parseDocument(fs.readFileSync(file, 'utf8'));
  const changes: string[] = [];
  let ws = doc.get('workspaces', true);
  if (!isSeq(ws)) {
    doc.set('workspaces', doc.createNode([]));
    ws = doc.get('workspaces', true);
  }
  const seq = ws as { items: unknown[]; flow?: boolean };
  seq.flow = false;
  const existing = (doc.toJS() as { workspaces?: { id: string; path: string }[] }).workspaces ?? [];
  const ids = new Set(existing.map((w) => w.id));
  for (const dir of add.workspaces) {
    const real = fs.realpathSync(dir);
    if (
      existing.some((w) => {
        try {
          return fs.realpathSync(w.path) === real;
        } catch {
          return false;
        }
      })
    )
      continue;
    const id = workspaceId(real, ids);
    ids.add(id);
    seq.items.push(doc.createNode({ id, path: real }));
    changes.push(`workspace ${id} → ${real}`);
  }
  if (add.flutter) {
    let ex = doc.get('executables', true);
    if (!isMap(ex)) {
      doc.set('executables', doc.createNode({}));
      ex = doc.get('executables', true);
    }
    (ex as { flow?: boolean }).flow = false;
    doc.setIn(['executables', 'flutter'], doc.createNode({ path: add.flutter }));
    changes.push(`executable flutter → ${add.flutter}`);
  }
  if (changes.length) fs.writeFileSync(file, doc.toString(), { mode: 0o600 });
  return changes;
}

function findOnPath(name: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  for (const dir of (env['PATH'] ?? '').split(':').filter(Boolean)) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

async function runTool(
  file: string,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ code: number; out: string }> {
  const clean = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const child = nodeExecPort().spawn({ file, argv, cwd: env['HOME'] ?? os.homedir(), env: clean });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(127));
    child.on('close', (c) => resolve(c ?? 1));
  });
  return { code, out: out.slice(0, 4000) };
}

function mcpEntry(e: CliEnv): { command: string; args: string[]; env?: Record<string, string> } {
  const home = e.env['AUTOTEST_HOME'];
  return {
    command: process.execPath,
    args: [serverEntryPath()],
    ...(home && path.isAbsolute(home) ? { env: { AUTOTEST_HOME: home } } : {}),
  };
}

export async function setup(e: CliEnv, io: Io, flags: SetupFlags): Promise<number> {
  const host = await hostChecks();
  for (const c of host.filter((x) => x.status !== 'PASS'))
    io.out(`${c.status}  ${c.name}  ${c.detail}${c.fix ? ` → ${c.fix}` : ''}`);
  if (host.some((c) => c.status === 'FAIL')) {
    io.err('Setup stopped: fix the failures above first.');
    return 1;
  }
  io.out(`Node ${process.versions.node} at ${process.execPath}`);
  await init(e, io);
  const config = path.join(dataRootOf(e.env), 'config.yaml');

  const workspaces = [...flags.workspaces];
  if (workspaces.length === 0 && !flags.yes && io.stdinIsTTY) {
    const answer = (await io.ask('Path of a repository to test (empty to skip): ')).trim();
    if (answer) workspaces.push(answer);
  }
  for (const w of workspaces)
    if (!fs.existsSync(w) || !fs.statSync(w).isDirectory()) {
      io.err(`Not a directory: ${w}`);
      return 1;
    }

  let flutter = flags.flutter;
  if (!flutter) {
    const found = suggestFlutter(e.env);
    if (found.length === 1 && (flags.yes || !io.stdinIsTTY)) flutter = found[0]!.path;
    else if (found.length >= 1 && io.stdinIsTTY && !flags.yes) {
      found.forEach((f, i) => io.out(`  ${i + 1}) ${f.path}  (${f.version ?? 'version unknown'})`));
      const pick = Number((await io.ask(`Flutter SDK to use [1-${found.length}, empty to skip]: `)).trim());
      if (Number.isInteger(pick) && pick >= 1 && pick <= found.length) flutter = found[pick - 1]!.path;
    } else if (found.length > 1)
      io.out(`Several Flutter SDKs found; pass --flutter <path> (see \`autotest doctor --suggest-executables\`).`);
  }
  if (flutter && !path.isAbsolute(flutter)) {
    io.err('--flutter needs an absolute path');
    return 1;
  }
  for (const c of updateConfig(config, { workspaces, ...(flutter ? { flutter } : {}) })) io.out(`config: ${c}`);

  const home = e.env['HOME'] ?? os.homedir();
  if (!flags.skipClaude) {
    const entry = mcpEntry(e);
    const claude = findOnPath('claude', e.env);
    if (claude) {
      await runTool(claude, ['mcp', 'remove', '--scope', 'user', 'autotest'], e.env);
      const envArgs = Object.entries(entry.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const r = await runTool(
        claude,
        ['mcp', 'add', '--scope', 'user', ...envArgs, 'autotest', '--', entry.command, ...entry.args],
        e.env,
      );
      if (r.code !== 0) {
        io.err(`\`claude mcp add\` failed (${r.code}): ${r.out.trim()}`);
        return 1;
      }
      io.out(`Claude Code: registered MCP server "autotest" (user scope) → ${entry.command} ${entry.args.join(' ')}`);
    } else {
      io.out(
        'Claude Code CLI not found on PATH. Add this to ~/.claude.json under "mcpServers" (or a project .mcp.json):',
      );
      io.out(JSON.stringify({ autotest: entry }, null, 2));
    }
    const target = path.join(home, '.claude', 'skills', 'pr-mobile-autotest');
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(skillSourcePath(), target, { recursive: true });
    io.out(`Claude Code: installed the pr-mobile-autotest Skill → ${target}`);
    io.out('\nRecommended: add these deny rules to ~/.claude/settings.json under "permissions" (not done for you):');
    io.out(JSON.stringify({ permissions: { deny: DENY_RULES } }, null, 2));
  }

  const checks = await doctorChecks(e);
  const failed = checks.filter((c) => c.status === 'FAIL');
  for (const c of checks.filter((x) => x.status !== 'PASS'))
    io.out(`${c.status}  ${c.name}  ${c.detail}${c.fix ? ` → ${c.fix}` : ''}`);
  io.out(
    failed.length
      ? `\nSetup finished with ${failed.length} problem(s); run \`autotest doctor\`.`
      : '\nSetup finished. Restart Claude Code, then ask it to test a PR.',
  );
  return failed.length ? 1 : 0;
}

export async function uninstallClaude(e: CliEnv, io: Io): Promise<number> {
  const claude = findOnPath('claude', e.env);
  if (claude) {
    const r = await runTool(claude, ['mcp', 'remove', '--scope', 'user', 'autotest'], e.env);
    io.out(
      r.code === 0
        ? 'Claude Code: removed MCP server "autotest" (user scope).'
        : 'Claude Code: no user-scope "autotest" server to remove.',
    );
  } else io.out('Claude Code CLI not found; remove "autotest" from ~/.claude.json by hand.');
  const target = path.join(e.env['HOME'] ?? os.homedir(), '.claude', 'skills', 'pr-mobile-autotest');
  if (
    fs.existsSync(path.join(target, 'SKILL.md')) &&
    /^name: pr-mobile-autotest$/m.test(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'))
  ) {
    fs.rmSync(target, { recursive: true, force: true });
    io.out(`Removed ${target}`);
  }
  io.out('The data root (~/.autotest) was kept; delete it yourself if you no longer need its runs and audit log.');
  return 0;
}
