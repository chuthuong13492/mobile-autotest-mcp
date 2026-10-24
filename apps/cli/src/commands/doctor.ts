/**
 * `autotest doctor` (CLI-002; operations §3, §6): prerequisite diagnostics with a remediation for every problem.
 * Read-only: it never changes configuration, never signals a process and never deletes anything. Exit 1 when any
 * check FAILs. `--audit` verifies only the audit chain; `--suggest-executables` proposes Flutter SDK paths for
 * `config.yaml` (the user copies and confirms them; PATH is never used at run time); `--stats` prints counts of runs
 * by state, authorization denials and quarantined artifacts (OPS-004).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTerminal, TERMINAL_RUN_STATES } from '@autotest/core';
import { directoryUsage, nodeExecPort } from '@autotest/exec';
import { supervisorAlive } from '@autotest/execution';
import {
  buildRegistry,
  loadPolicyConfig,
  nodeFsPort,
  resolveWorkspaces,
  validateSpec,
  type PolicyConfig,
} from '@autotest/policy';
import { openDataRoot, verifyAuditFiles } from '@autotest/storage';
import { dataRootOf, type CliEnv } from '../context.ts';
import type { Io } from '../io.ts';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'INFO';
export interface Check {
  readonly status: CheckStatus;
  readonly name: string;
  readonly detail: string;
  readonly fix?: string;
}

export const MIN_NODE_MAJOR = 24;

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const exists = (p: string) => fs.existsSync(p);

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Node, platform, sqlite and process-table checks (shared with `autotest setup`). */
export async function hostChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { status: 'PASS', name: 'node', detail: `Node ${process.versions.node} at ${process.execPath}` }
      : {
          status: 'FAIL',
          name: 'node',
          detail: `Node ${process.versions.node} is too old`,
          fix: `Install Node ${MIN_NODE_MAJOR} or newer and run autotest with it`,
        },
  );
  try {
    await import('node:sqlite');
    checks.push({ status: 'PASS', name: 'sqlite', detail: 'node:sqlite is available' });
  } catch {
    checks.push({
      status: 'FAIL',
      name: 'sqlite',
      detail: 'node:sqlite is not available',
      fix: `Use Node ${MIN_NODE_MAJOR}+`,
    });
  }
  const platform = process.platform;
  checks.push(
    platform === 'darwin' || platform === 'linux'
      ? { status: 'PASS', name: 'platform', detail: `${platform} ${os.arch()}` }
      : {
          status: 'FAIL',
          name: 'platform',
          detail: `${platform} is not supported`,
          fix: 'Use macOS or Linux (Windows is not supported in v1)',
        },
  );
  const ps = (() => {
    try {
      return nodeExecPort().processInfo(process.pid) !== undefined;
    } catch {
      return false;
    }
  })();
  checks.push(
    ps
      ? { status: 'PASS', name: 'process-table', detail: 'ps reports process groups and start times' }
      : {
          status: 'FAIL',
          name: 'process-table',
          detail: '`ps -o pid=,pgid=,stat=,lstart=` does not work',
          fix: 'Install procps (Debian/Ubuntu: apt install procps; Alpine: apk add procps)',
        },
  );
  return checks;
}

/** GitHub: `gh` allowlisted and logged in (`gh auth status`, exit code only; the token is never read here). */
async function githubChecks(cfg: PolicyConfig, env: Readonly<Record<string, string | undefined>>): Promise<Check[]> {
  const fsp = nodeFsPort();
  const registry = buildRegistry(fsp, cfg.executables);
  const pub = cfg.github.publication;
  const pubCheck: Check = pub.enabled
    ? {
        status: 'INFO',
        name: 'github',
        detail: `publication enabled: ${pub.mechanisms.join(', ') || 'no mechanism listed'} (each write needs \`autotest approve\`)`,
      }
    : {
        status: 'INFO',
        name: 'github',
        detail: 'publication disabled (read-only); enable with `autotest setup --enable-publication`',
      };
  if (!registry.executables.has('gh'))
    return [
      {
        status: 'WARN',
        name: 'github',
        detail: 'gh is not allowlisted: GitHub PRs are unavailable',
        fix: 'Install the GitHub CLI, `gh auth login`, then rerun `autotest setup`',
      },
      pubCheck,
    ];
  const v = validateSpec(
    {
      executable: 'gh',
      args: [
        { kind: 'word', value: 'auth' },
        { kind: 'word', value: 'status' },
        { kind: 'flag', name: '--hostname', value: 'github.com' },
      ],
      cwd: '.',
      envNeeds: [],
      expectedOutputs: [],
      timeoutMs: 10_000,
      cancellation: 'process_group',
      requires: { host: 'any', device: 'none' },
    },
    {
      fs: fsp,
      registry,
      workspaceRoot: os.tmpdir(),
      runDir: os.tmpdir(),
      allowDependencyResolution: false,
      allowedClasses: ['probe'],
    },
  );
  if (!v.ok) return [{ status: 'FAIL', name: 'github', detail: 'gh auth status was denied by policy' }, pubCheck];
  const childEnv: Record<string, string> = {
    PATH: `${path.dirname(v.executablePath)}:/usr/bin:/bin`,
    HOME: env['HOME'] ?? os.homedir(),
    GH_NO_UPDATE_NOTIFIER: '1',
  };
  for (const k of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'])
    if (env[k]) childEnv[k] = env[k]!;
  const child = nodeExecPort().spawn({ file: v.executablePath, argv: v.argv, cwd: os.tmpdir(), env: childEnv });
  child.stdout?.resume();
  child.stderr?.resume();
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => (child.kill('SIGKILL'), resolve(124)), 10_000);
    child.on('error', () => resolve(127));
    child.on('close', (c) => (clearTimeout(timer), resolve(c ?? 1)));
  });
  return [
    code === 0
      ? { status: 'PASS', name: 'github', detail: 'gh is logged in to github.com' }
      : {
          status: 'WARN',
          name: 'github',
          detail: 'gh is not logged in to github.com',
          fix: 'Run `gh auth login --hostname github.com`',
        },
    pubCheck,
  ];
}

/** Secret references: this build resolves `env:` only (OPS-004). */
function secretChecks(cfg: PolicyConfig, env: Readonly<Record<string, string | undefined>>): Check[] {
  const refs = [
    ...cfg.env.secrets.map((s) => ({ where: `env.secrets.${s.name}`, ref: s.ref })),
    ...cfg.github.hosts.flatMap((h) =>
      h.credentialRef ? [{ where: `github.hosts.${h.host}`, ref: h.credentialRef }] : [],
    ),
  ];
  return refs.flatMap(({ where, ref }): Check[] => {
    if (ref.startsWith('keychain:'))
      return [
        {
          status: 'FAIL',
          name: 'secrets',
          detail: `${where} uses a keychain: reference, which this build cannot resolve`,
          fix: 'Use env:<NAME> and export the variable in the environment that starts the server',
        },
      ];
    if (env[ref.slice(4)] === undefined)
      return [
        {
          status: 'WARN',
          name: 'secrets',
          detail: `${where}: ${ref} is not set in this shell`,
          fix: 'Export it where Claude Code starts the server (doctor only sees its own environment)',
        },
      ];
    return [];
  });
}

/** Data-root size against the retention cap, and baseline worktrees left by a stopped supervisor. */
function diskChecks(root: string, cfg: PolicyConfig, terminal: (runId: string) => boolean): Check[] {
  const checks: Check[] = [];
  const runsDir = path.join(root, 'runs');
  const ids = exists(runsDir) ? fs.readdirSync(runsDir).filter((n) => /^run_[0-9A-Z]{26}$/.test(n)) : [];
  const bytes = [runsDir, path.join(root, 'tmp')]
    .filter(exists)
    .reduce((n, d) => n + directoryUsage(d, Number.MAX_SAFE_INTEGER).bytes, 0);
  const cap = cfg.retention.totalCapBytes;
  checks.push(
    bytes > cap
      ? {
          status: 'WARN',
          name: 'disk',
          detail: `run data uses ${Math.round(bytes / 1048576)} MiB, above the ${Math.round(cap / 1048576)} MiB cap`,
          fix: 'Run `autotest cleanup --dry-run`, then `autotest cleanup`; lower `retention` if needed',
        }
      : {
          status: 'PASS',
          name: 'disk',
          detail: `run data ${Math.round(bytes / 1048576)} MiB of ${Math.round(cap / 1048576)} MiB`,
        },
  );
  const leftovers = ids.filter((id) => terminal(id) && exists(path.join(runsDir, id, 'baseline')));
  if (leftovers.length)
    checks.push({
      status: 'WARN',
      name: 'worktrees',
      detail: `${leftovers.length} finished baseline run(s) still have a git worktree`,
      fix: 'Run `autotest cleanup` (removes them and prunes git worktree records)',
    });
  return checks;
}

export async function doctorChecks(e: CliEnv): Promise<Check[]> {
  const checks = await hostChecks();
  const root = dataRootOf(e.env);
  if (!exists(root)) {
    checks.push({
      status: 'FAIL',
      name: 'data-root',
      detail: `${root} does not exist`,
      fix: 'Run `autotest init` (or `autotest setup`)',
    });
    return checks;
  }
  checks.push(
    mode(root) === 0o700
      ? { status: 'PASS', name: 'data-root', detail: `${root} (0700)` }
      : {
          status: 'FAIL',
          name: 'data-root',
          detail: `${root} has mode ${mode(root).toString(8)}`,
          fix: `chmod 700 ${root}`,
        },
  );
  const configFile = path.join(root, 'config.yaml');
  if (!exists(configFile)) {
    checks.push({
      status: 'FAIL',
      name: 'config',
      detail: 'config.yaml is missing',
      fix: 'Run `autotest init`, then add workspaces and executables',
    });
    return checks;
  }
  if (mode(configFile) & 0o077)
    checks.push({
      status: 'WARN',
      name: 'config-mode',
      detail: `config.yaml has mode ${mode(configFile).toString(8)}`,
      fix: `chmod 600 ${configFile}`,
    });
  const policy = loadPolicyConfig(fs.readFileSync(configFile, 'utf8'));
  if (!policy.ok) {
    checks.push({
      status: 'FAIL',
      name: 'config',
      detail: policy.error.error.message.slice(0, 300),
      fix: 'Fix config.yaml; tools refuse to run without a valid policy (E_POLICY_UNAVAILABLE)',
    });
    return checks;
  }
  const cfg = policy.policy.config;
  checks.push({
    status: 'PASS',
    name: 'config',
    detail: `policy ${policy.policy.policyVersion.slice(0, 19)}…, gate ${policy.policy.gatePolicyVersion.slice(0, 19)}…`,
  });

  const fsp = nodeFsPort();
  const ws = resolveWorkspaces(fsp, cfg.workspaces);
  if (cfg.workspaces.length === 0)
    checks.push({
      status: 'WARN',
      name: 'workspaces',
      detail: 'no workspace is allowlisted',
      fix: 'Add your repository under `workspaces:` in config.yaml (or run `autotest setup --workspace <path>`)',
    });
  for (const id of ws.unavailable)
    checks.push({
      status: 'FAIL',
      name: 'workspaces',
      detail: `workspace ${id} does not exist or is not a directory`,
      fix: 'Fix its path in config.yaml',
    });
  for (const w of ws.workspaces) {
    const flutter = exists(path.join(w.realPath, 'pubspec.yaml'));
    checks.push({
      status: 'PASS',
      name: 'workspaces',
      detail: `${w.id} → ${w.realPath}${w.readOnlyReference ? ' (read-only reference)' : ''}`,
    });
    if (flutter && !w.readOnlyReference && !exists(path.join(w.realPath, '.dart_tool', 'package_config.json')))
      checks.push({
        status: 'WARN',
        name: 'dependencies',
        detail: `${w.id}: Flutter dependencies are not resolved`,
        fix: `Run \`flutter pub get\` in ${w.realPath} (runs use --no-pub)`,
      });
  }

  const registry = buildRegistry(fsp, cfg.executables);
  if (Object.keys(cfg.executables).length === 0)
    checks.push({
      status: 'WARN',
      name: 'executables',
      detail: 'no executable is allowlisted, so no test can run',
      fix: 'Run `autotest doctor --suggest-executables` and add `flutter` to config.yaml',
    });
  for (const [name, exe] of registry.executables)
    checks.push({
      status: 'PASS',
      name: 'executables',
      detail: `${name} → ${exe.realPath}${exe.sha256 ? ' (pinned)' : ''}`,
    });
  for (const p of registry.problems)
    checks.push({
      status: 'FAIL',
      name: 'executables',
      detail: `${p.logical}: ${p.reason.replace('_', ' ')}`,
      fix:
        p.reason === 'hash_mismatch'
          ? 'The SDK changed: verify it, then update its sha256 pin'
          : 'Fix the path in config.yaml (`autotest doctor --suggest-executables`)',
    });

  checks.push(...secretChecks(cfg, e.env));
  checks.push(...(await githubChecks(cfg, e.env)));
  if (mode(root) !== 0o700) return checks; // the index refuses an insecure data root; fix that first
  const { sql, stores } = openDataRoot(root);
  try {
    const quick = sql.get<{ quick_check: string }>('PRAGMA quick_check');
    checks.push(
      quick?.quick_check === 'ok'
        ? { status: 'PASS', name: 'sqlite-index', detail: 'quick_check ok' }
        : {
            status: 'FAIL',
            name: 'sqlite-index',
            detail: `quick_check: ${quick?.quick_check ?? 'no answer'}`,
            fix: 'Move autotest.db aside; the files are authoritative and the index is rebuilt',
          },
    );
    const audit = verifyAuditFiles(root);
    checks.push(
      audit.ok
        ? { status: 'PASS', name: 'audit-chain', detail: `${audit.events} events in ${audit.files} file(s)` }
        : {
            status: 'FAIL',
            name: 'audit-chain',
            detail: `${audit.problem} at ${audit.file}:${audit.line}`,
            fix: 'Investigate local tampering; see operations §4',
          },
    );
    const terminalIds = new Set(
      sql
        .all<{ id: string }>(
          `SELECT id FROM runs WHERE state IN (${TERMINAL_RUN_STATES.map(() => '?').join(',')})`,
          ...TERMINAL_RUN_STATES,
        )
        .map((r) => r.id),
    );
    checks.push(...diskChecks(root, cfg, (id) => terminalIds.has(id)));
    for (const run of await stores.runs.listNonTerminal()) {
      if (isTerminal(run.state) || (run.state === 'queued' && !run.supervisor)) continue;
      if (run.state === 'cancel_pending')
        checks.push({
          status: 'WARN',
          name: 'runs',
          detail: `${run.id} is cancel_pending`,
          fix: 'Check its survivor processes (get_run_status) and end them manually if they are the run’s',
        });
      else if (!run.supervisor || !supervisorAlive(run.supervisor))
        checks.push({
          status: 'WARN',
          name: 'runs',
          detail: `${run.id} is ${run.state} but its supervisor is gone`,
          fix: 'Run `autotest cleanup` (reconciles it) or start the server',
        });
    }
  } finally {
    sql.close();
  }

  const home = e.env['HOME'] ?? os.homedir();
  const claudeJson = readJsonFile(path.join(home, '.claude.json')) as
    | { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> }
    | undefined;
  const registered =
    Object.hasOwn(claudeJson?.mcpServers ?? {}, 'autotest') ||
    Object.values(claudeJson?.projects ?? {}).some((p) => Object.hasOwn(p.mcpServers ?? {}, 'autotest'));
  checks.push(
    registered
      ? { status: 'PASS', name: 'claude-code', detail: 'the autotest MCP server is registered' }
      : {
          status: 'WARN',
          name: 'claude-code',
          detail: 'the autotest MCP server is not registered in ~/.claude.json',
          fix: 'Run `autotest setup` (or add it to the project’s .mcp.json)',
        },
  );
  const skill = path.join(home, '.claude', 'skills', 'pr-mobile-autotest', 'SKILL.md');
  checks.push(
    exists(skill)
      ? { status: 'PASS', name: 'skill', detail: skill }
      : {
          status: 'WARN',
          name: 'skill',
          detail: 'the pr-mobile-autotest Skill is not installed for this user',
          fix: 'Run `autotest setup` (copies the Skill to ~/.claude/skills)',
        },
  );
  const settings = fs.existsSync(path.join(home, '.claude', 'settings.json'))
    ? fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')
    : '';
  checks.push(
    settings.includes('autotest approve')
      ? { status: 'PASS', name: 'deny-rules', detail: 'Claude Code denies `autotest approve` to the agent' }
      : {
          status: 'WARN',
          name: 'deny-rules',
          detail: 'no Claude Code deny rule for `autotest approve`',
          fix: 'Add the deny rules printed by `autotest setup` to ~/.claude/settings.json (RK-01)',
        },
  );
  return checks;
}

/** Candidate Flutter SDKs on this machine (PATH, FVM, common install folders), with their `version` file. */
export function suggestFlutter(
  env: Readonly<Record<string, string | undefined>>,
): { path: string; version: string | null }[] {
  const home = env['HOME'] ?? os.homedir();
  const candidates = [
    ...(env['PATH'] ?? '')
      .split(':')
      .filter(Boolean)
      .map((d) => path.join(d, 'flutter')),
    path.join(home, 'fvm', 'default', 'bin', 'flutter'),
    ...(exists(path.join(home, 'fvm', 'versions'))
      ? fs
          .readdirSync(path.join(home, 'fvm', 'versions'))
          .sort()
          .map((v) => path.join(home, 'fvm', 'versions', v, 'bin', 'flutter'))
      : []),
    path.join(home, 'development', 'flutter', 'bin', 'flutter'),
    path.join(home, 'Development', 'flutter', 'bin', 'flutter'),
    path.join(home, 'flutter', 'bin', 'flutter'),
    '/opt/flutter/bin/flutter',
    '/usr/local/flutter/bin/flutter',
    '/snap/flutter/current/flutter/bin/flutter',
  ];
  const seen = new Map<string, string | null>();
  for (const c of candidates) {
    let real: string;
    try {
      // The native realpath also normalizes letter case on case-insensitive volumes (macOS).
      real = fs.realpathSync.native(c);
      if (!fs.statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.set(real, sdkVersion(path.dirname(path.dirname(real))));
  }
  return [...seen].map(([p, version]) => ({ path: p, version }));
}

/**
 * The SDK's version from its own files (no process is started): `bin/cache/flutter.version.json` (current SDKs)
 * or the legacy `version` file.
 */
function sdkVersion(sdkRoot: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'bin', 'cache', 'flutter.version.json'), 'utf8')) as {
      frameworkVersion?: unknown;
    };
    if (typeof j.frameworkVersion === 'string') return j.frameworkVersion.slice(0, 40);
  } catch {
    // fall through to the legacy file
  }
  try {
    return fs.readFileSync(path.join(sdkRoot, 'version'), 'utf8').trim().slice(0, 40) || null;
  } catch {
    return null;
  }
}

export async function doctor(e: CliEnv, io: Io, flags: readonly string[]): Promise<number> {
  if (flags.includes('--suggest-executables')) {
    const found = suggestFlutter(e.env);
    if (found.length === 0) {
      io.out('No Flutter SDK found on PATH, in ~/fvm or in common install folders.');
      return 1;
    }
    io.out('Flutter SDKs found (copy ONE into config.yaml under `executables:`, after checking it):');
    for (const f of found) io.out(`  flutter: { path: ${f.path} }   # ${f.version ?? 'version unknown'}`);
    return 0;
  }
  if (flags.includes('--audit')) {
    const audit = verifyAuditFiles(dataRootOf(e.env));
    io.out(
      audit.ok
        ? `PASS  audit-chain  ${audit.events} events in ${audit.files} file(s)`
        : `FAIL  audit-chain  ${audit.problem} at ${audit.file}:${audit.line}`,
    );
    return audit.ok ? 0 : 1;
  }
  if (flags.includes('--stats')) return stats(e, io);
  const checks = await doctorChecks(e);
  for (const c of checks) {
    io.out(`${c.status.padEnd(4)}  ${c.name.padEnd(13)} ${c.detail}`);
    if (c.fix && c.status !== 'PASS') io.out(`      ${' '.repeat(13)} → ${c.fix}`);
  }
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const warned = checks.filter((c) => c.status === 'WARN').length;
  io.out(`\n${failed} failed, ${warned} warning(s).`);
  return failed > 0 ? 1 : 0;
}

/** `doctor --stats`: counts only (no content), read from the index. */
async function stats(e: CliEnv, io: Io): Promise<number> {
  const root = dataRootOf(e.env);
  if (!exists(path.join(root, 'autotest.db'))) {
    io.out('No data yet (the index does not exist).');
    return 0;
  }
  const { sql } = openDataRoot(root);
  try {
    const rows = <T>(q: string) => sql.all<T & { n: number }>(q);
    io.out('Runs by state:');
    for (const r of rows<{ state: string }>('SELECT state, COUNT(*) AS n FROM runs GROUP BY state ORDER BY state'))
      io.out(`  ${r.state.padEnd(16)} ${r.n}`);
    const denials = rows<{ n: number }>("SELECT COUNT(*) AS n FROM authorization_decisions WHERE result = 'denied'")[0]
      ?.n;
    const quarantined = rows<{ n: number }>('SELECT COUNT(*) AS n FROM artifacts WHERE quarantined = 1')[0]?.n;
    io.out(`Authorization denials: ${denials ?? 0}`);
    io.out(`Quarantined artifacts: ${quarantined ?? 0}`);
    return 0;
  } finally {
    sql.close();
  }
}
