/**
 * GitHub access for the server (GH-001; ADR-0013 update 2026-10-24: github.com via the `gh` CLI credential).
 *
 * The token comes from the user's existing `gh` login: `gh auth token --hostname <host>` is validated against the
 * `gh` argument schema (probe class) and spawned through the exec port with stdout piped, so the token is never
 * written to disk; it is cached in memory and refreshed after a 401. A host may instead name a `credentialRef`
 * (`env:NAME`). `gh` must be allowlisted under `executables` (PATH is never searched; `autotest setup` adds it).
 */
import os from 'node:os';
import path from 'node:path';
import { createGitHubClient, GitHubError, type GitHubClient, type TokenProvider } from '@autotest/github';
import { nodeExecPort, type ExecPort } from '@autotest/exec';
import { buildRegistry, envSecretResolver, nodeFsPort, validateSpec, type LoadedPolicy } from '@autotest/policy';

export interface GitHubAccess {
  /** A client for a configured host, or a `GitHubError` explaining why GitHub cannot be used. */
  client(host: string): GitHubClient;
}

export interface GitHubAccessOptions {
  readonly policy: LoadedPolicy;
  readonly dataRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Tests: API base URL and fetch override (production uses https://api.github.com). */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly port?: ExecPort;
}

const TOKEN = /^[A-Za-z0-9_\-.]{20,255}$/;

/** Runs `gh auth token --hostname <host>` and returns the token from stdout (memory only). */
export async function ghAuthToken(o: GitHubAccessOptions, host: string): Promise<string> {
  const fsp = nodeFsPort();
  const registry = buildRegistry(fsp, o.policy.config.executables);
  if (!registry.executables.has('gh'))
    throw new GitHubError(
      'E_GITHUB_AUTH',
      'gh is not allowlisted: add it under `executables` (or run `autotest setup`)',
    );
  const v = validateSpec(
    {
      executable: 'gh',
      args: [
        { kind: 'word', value: 'auth' },
        { kind: 'word', value: 'token' },
        { kind: 'flag', name: '--hostname', value: host },
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
      workspaceRoot: o.dataRoot,
      runDir: o.dataRoot,
      allowDependencyResolution: false,
      allowedClasses: ['probe'],
    },
  );
  if (!v.ok)
    throw new GitHubError(
      'E_GITHUB_AUTH',
      `gh auth token was denied by policy (${v.denials.map((d) => d.code).join(',')})`,
    );
  // gh reads its login from the user's real config (and the OS keychain), so this child gets the real HOME and
  // the gh config variables only; nothing else from the server's environment.
  const env: Record<string, string> = {
    PATH: `${path.dirname(v.executablePath)}:/usr/bin:/bin`,
    HOME: o.env['HOME'] ?? os.homedir(),
    LANG: 'en_US.UTF-8',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PROMPT_DISABLED: '1',
  };
  for (const k of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
    const val = o.env[k];
    if (val) env[k] = val;
  }
  const child = (o.port ?? nodeExecPort()).spawn({ file: v.executablePath, argv: v.argv, cwd: o.dataRoot, env });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => {
    if (out.length < 4096) out += d.toString('utf8');
  });
  child.stderr?.resume();
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(124);
    }, 10_000);
    child.on('error', () => resolve(127));
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c ?? 1);
    });
  });
  const token = out.trim();
  if (code !== 0 || !TOKEN.test(token))
    throw new GitHubError(
      'E_GITHUB_AUTH',
      `gh has no usable login for ${host}: run \`gh auth login --hostname ${host}\``,
    );
  return token;
}

export function createGitHubAccess(o: GitHubAccessOptions): GitHubAccess {
  const clients = new Map<string, GitHubClient>();
  return {
    client(host) {
      const entry = o.policy.config.github.hosts.find((h) => h.host === host);
      if (!entry)
        throw new GitHubError('E_GITHUB_AUTH', `${host} is not a configured GitHub host (github.hosts in config.yaml)`);
      if (host !== 'github.com' && !entry.apiBaseUrl)
        throw new GitHubError(
          'E_GITHUB_FEATURE_UNAVAILABLE',
          `${host} needs an apiBaseUrl in github.hosts (GitHub Enterprise Server: https://${host}/api/v3); \`autotest setup --github-host ${host}\` adds it`,
        );
      const cached = clients.get(host);
      if (cached) return cached;
      let token: string | undefined;
      const provider: TokenProvider = {
        async get() {
          if (token) return token;
          if (entry.credentialRef) {
            const v = await envSecretResolver(o.env).resolve(entry.credentialRef);
            if (!v) throw new GitHubError('E_GITHUB_AUTH', `the credential reference for ${host} resolved to nothing`);
            token = v;
          } else token = await ghAuthToken(o, host);
          return token;
        },
        invalidate() {
          token = undefined;
        },
      };
      const client = createGitHubClient({
        token: provider,
        baseUrl: o.baseUrl ?? entry.apiBaseUrl ?? 'https://api.github.com',
        ...(o.fetch ? { fetch: o.fetch } : {}),
      });
      clients.set(host, client);
      return client;
    },
  };
}
