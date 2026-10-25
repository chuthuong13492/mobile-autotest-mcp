/**
 * `autotest setup` (M7, part of REL-001): one command that makes a machine ready.
 *
 * 1. Host checks (Node 24+, node:sqlite, ps); stop on a failure.
 * 2. `init` (data root 0700 and a commented config 0600; an existing config is kept).
 * 3. Optional: add `--workspace <path>` entries and the Flutter SDK (`--flutter <path>`, or a single SDK found by
 *    `doctor --suggest-executables`, or a choice when interactive) to `config.yaml`, preserving its comments. `gh`
 *    found on PATH is allowlisted (read-only login use); `--enable-publication` turns on GitHub writes.
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
  /** Turn on GitHub writes (comment, check run, commit status); each write still needs a human approval. */
  readonly enablePublication?: boolean;
}

export function parseSetupFlags(args: readonly string[]): SetupFlags | undefined {
  const workspaces: string[] = [];
  let flutter: string | undefined;
  let yes = false;
  let skipClaude = false;
  let enablePublication = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--yes') yes = true;
    else if (a === '--enable-publication') enablePublication = true;
    else if (a === '--skip-claude') skipClaude = true;
    else if ((a === '--workspace' || a === '--flutter') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      if (a === '--workspace') workspaces.push(args[++i]!);
      else flutter = args[++i]!;
    } else return undefined;
  }
  return {
    yes,
    workspaces,
    ...(flutter ? { flutter } : {}),
    skipClaude,
    ...(enablePublication ? { enablePublication } : {}),
  };
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
export function updateConfig(
  file: string,
  add: {
    workspaces: readonly string[];
    flutter?: string;
    gh?: string;
    git?: string;
    /** Device tools (DEV-001/002): xcrun, adb, emulator, avdmanager → absolute paths. */
    devices?: Readonly<Record<string, string>>;
    enablePublication?: boolean;
  },
): string[] {
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
  if (add.gh && !doc.hasIn(['executables', 'gh'])) {
    if (!isMap(doc.get('executables', true))) doc.set('executables', doc.createNode({}));
    (doc.get('executables', true) as { flow?: boolean }).flow = false;
    doc.setIn(['executables', 'gh'], doc.createNode({ path: add.gh }));
    changes.push(`executable gh → ${add.gh} (read-only use: gh auth token / gh auth status)`);
  }
  if (add.git && !doc.hasIn(['executables', 'git'])) {
    if (!isMap(doc.get('executables', true))) doc.set('executables', doc.createNode({}));
    (doc.get('executables', true) as { flow?: boolean }).flow = false;
    doc.setIn(['executables', 'git'], doc.createNode({ path: add.git }));
    changes.push(`executable git → ${add.git} (baseline worktrees only: rev-parse, worktree add/remove/prune)`);
  }
  // Android device runs build with Gradle: the SDK, the JDK and the shared Gradle cache must reach the runner.
  if (add.devices?.['emulator']) {
    const allow = (doc.getIn(['env', 'allow']) as { toJSON(): unknown } | undefined)?.toJSON?.() as
      string[] | undefined;
    const missing = ANDROID_RUN_ENV.filter((n) => !(allow ?? []).includes(n));
    if (missing.length) {
      doc.setIn(['env', 'allow'], doc.createNode([...(allow ?? []), ...missing]));
      changes.push(`env.allow + ${missing.join(', ')} (Android builds on emulators)`);
    }
  }
  for (const [name, exe] of Object.entries(add.devices ?? {})) {
    if (doc.hasIn(['executables', name])) continue;
    if (!isMap(doc.get('executables', true))) doc.set('executables', doc.createNode({}));
    (doc.get('executables', true) as { flow?: boolean }).flow = false;
    doc.setIn(['executables', name], doc.createNode({ path: exe }));
    changes.push(`executable ${name} → ${exe} (simulators and emulators AutoTest owns; others need approval)`);
  }
  if (add.enablePublication) {
    doc.setIn(
      ['github', 'publication'],
      doc.createNode({ enabled: true, mechanisms: ['comment', 'check_run', 'commit_status'] }),
    );
    changes.push(
      'github publication enabled (comment, check_run, commit_status); every write still needs `autotest approve`',
    );
  }
  if (changes.length) fs.writeFileSync(file, doc.toString(), { mode: 0o600 });
  return changes;
}

/**
 * Device tools (DEV-001/002): xcrun from PATH (macOS), and adb, emulator and avdmanager from the Android SDK
 * (`ANDROID_HOME` or `ANDROID_SDK_ROOT`), falling back to PATH; `java` (AND-003, the JDK that runs the Gradle
 * wrapper) from `JAVA_HOME`, falling back to PATH but never the macOS `/usr/bin/java` launcher stub. Only existing
 * files are returned, as real paths.
 */
function findDeviceTools(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const sdk = env['ANDROID_HOME'] ?? env['ANDROID_SDK_ROOT'];
  const candidates: Record<string, (string | undefined)[]> = {
    xcrun: [findOnPath('xcrun', env)],
    xcodebuild: [findOnPath('xcodebuild', env)],
    adb: [sdk && path.join(sdk, 'platform-tools', 'adb'), findOnPath('adb', env)],
    emulator: [sdk && path.join(sdk, 'emulator', 'emulator'), findOnPath('emulator', env)],
    avdmanager: [sdk && path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager'), findOnPath('avdmanager', env)],
    java: [
      env['JAVA_HOME'] && path.join(env['JAVA_HOME'], 'bin', 'java'),
      ...[findOnPath('java', env)].filter((p) => p !== '/usr/bin/java'),
    ],
  };
  const out: Record<string, string> = {};
  for (const [name, paths] of Object.entries(candidates)) {
    const hit = paths.find((p): p is string => !!p && fs.existsSync(p) && fs.statSync(p).isFile());
    if (hit) out[name] = fs.realpathSync(hit);
  }
  return out;
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

/** Variables an Android device run needs (the runner otherwise gets a minimal environment). */
const ANDROID_RUN_ENV = ['ANDROID_HOME', 'JAVA_HOME', 'GRADLE_USER_HOME'] as const;

function mcpEntry(e: CliEnv): { command: string; args: string[]; env?: Record<string, string> } {
  const home = e.env['AUTOTEST_HOME'];
  const env: Record<string, string> = {};
  if (home && path.isAbsolute(home)) env['AUTOTEST_HOME'] = home;
  // Values for the Android run variables, so the server (and its runs) see them however Claude Code is started.
  const sdk = e.env['ANDROID_HOME'] ?? e.env['ANDROID_SDK_ROOT'];
  if (sdk && path.isAbsolute(sdk)) {
    env['ANDROID_HOME'] = sdk;
    if (e.env['JAVA_HOME'] && path.isAbsolute(e.env['JAVA_HOME'])) env['JAVA_HOME'] = e.env['JAVA_HOME'];
    env['GRADLE_USER_HOME'] = e.env['GRADLE_USER_HOME'] ?? path.join(e.env['HOME'] ?? os.homedir(), '.gradle');
  }
  return { command: process.execPath, args: [serverEntryPath()], ...(Object.keys(env).length ? { env } : {}) };
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
  // gh is allowlisted for reading the user's GitHub login (github.com PRs, GH-001); PATH is used only here, once.
  const ghOnPath = findOnPath('gh', e.env);
  const gh = ghOnPath ? fs.realpathSync(ghOnPath) : undefined;
  // git is allowlisted for baseline runs (ANL-002): a checkout of the base commit inside the run directory.
  const gitOnPath = findOnPath('git', e.env);
  const git = gitOnPath ? fs.realpathSync(gitOnPath) : undefined;
  const devices = findDeviceTools(e.env);
  for (const c of updateConfig(config, {
    workspaces,
    ...(flutter ? { flutter } : {}),
    ...(gh ? { gh } : {}),
    ...(git ? { git } : {}),
    devices,
    ...(flags.enablePublication ? { enablePublication: true } : {}),
  }))
    io.out(`config: ${c}`);
  if (!gh)
    io.out(
      'GitHub CLI (gh) not found on PATH: GitHub PRs stay unavailable until you install it, `gh auth login`, and rerun setup.',
    );

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
