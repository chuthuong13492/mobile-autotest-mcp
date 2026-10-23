/**
 * Child-process environment (POL-004; SR-004, SR-013; T-05).
 *
 * The child environment is built, never inherited: `PATH` from allowlisted directories, run-scoped `HOME` and
 * `TMPDIR`, locale, the `env.allow` variables present in the parent snapshot, and the secrets the spec asks for that
 * are scoped to its workspace. Secret values are resolved at spawn time through a {@link SecretResolver} and
 * returned so the caller registers them with the run's redactor before spawning.
 */
import path from 'node:path';
import type { PolicyConfig } from './config.ts';

/** Resolves a secret reference (`keychain:…`, `env:…`) to its value, or `undefined` when it does not exist. */
export interface SecretResolver {
  resolve(ref: string): Promise<string | undefined>;
}

/** Resolver for `env:NAME` references over an explicit environment snapshot. Other schemes are unsupported. */
export function envSecretResolver(snapshot: Readonly<Record<string, string | undefined>>): SecretResolver {
  return {
    resolve: async (ref) => {
      if (!ref.startsWith('env:'))
        throw new SecretResolutionError(`unsupported secret reference scheme: ${ref.split(':')[0]}`);
      return snapshot[ref.slice(4)];
    },
  };
}

export class SecretResolutionError extends Error {
  override readonly name = 'SecretResolutionError';
}

export interface ChildEnvRequest {
  readonly env: PolicyConfig['env'];
  readonly workspaceId: string;
  /** `ExecutionSpec.envNeeds`. */
  readonly needs: readonly string[];
  /** Run-scoped directories (created by the caller). */
  readonly home: string;
  readonly tmpDir: string;
  /** Directory of the resolved executable, prepended to PATH. */
  readonly executableDir?: string;
  /** Explicit snapshot of the parent environment; only allowlisted names are read from it. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly resolver: SecretResolver;
}

export type EnvDenialCode = 'env_not_allowed' | 'secret_not_scoped' | 'secret_unavailable';

export type ChildEnvResult =
  | {
      readonly ok: true;
      readonly env: Readonly<Record<string, string>>;
      readonly secretValues: readonly string[];
      readonly secretNames: readonly string[];
    }
  | { readonly ok: false; readonly denials: readonly { readonly code: EnvDenialCode; readonly name: string }[] };

/** Builds the environment for one spawn. Any unsatisfiable need denies the whole spawn. */
export async function buildChildEnv(req: ChildEnvRequest): Promise<ChildEnvResult> {
  const dirs = [...(req.executableDir ? [req.executableDir] : []), ...req.env.pathDirs].filter(
    (d, i, a) => path.isAbsolute(d) && !d.includes(':') && a.indexOf(d) === i,
  );
  const env: Record<string, string> = {
    PATH: dirs.join(':'),
    HOME: req.home,
    TMPDIR: req.tmpDir,
    LANG: req.env.locale,
    LC_ALL: req.env.locale,
  };
  for (const name of req.env.allow) {
    const v = req.parentEnv[name];
    if (v !== undefined) env[name] = v;
  }

  const denials: { code: EnvDenialCode; name: string }[] = [];
  const secretValues: string[] = [];
  const secretNames: string[] = [];
  for (const need of new Set(req.needs)) {
    if (need in env) continue;
    const secret = req.env.secrets.find((s) => s.name === need);
    if (!secret) {
      denials.push({ code: 'env_not_allowed', name: need });
      continue;
    }
    if (!secret.workspaces.includes(req.workspaceId)) {
      denials.push({ code: 'secret_not_scoped', name: need });
      continue;
    }
    let value: string | undefined;
    try {
      value = await req.resolver.resolve(secret.ref);
    } catch {
      value = undefined;
    }
    if (value === undefined || value.length === 0) {
      denials.push({ code: 'secret_unavailable', name: need });
      continue;
    }
    env[need] = value;
    secretValues.push(value);
    secretNames.push(need);
  }
  if (denials.length) return { ok: false, denials };
  return { ok: true, env: Object.freeze(env), secretValues, secretNames };
}
