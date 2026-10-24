/**
 * GitHub REST client (GH-001; ADR-0013, github.com via the `gh` credential since 2026-10-24).
 *
 * - `fetch` (Node 24) with no SDK dependency. Only the endpoints AutoTest needs are callable: each request is
 *   matched against a fixed method + path allowlist, so no caller can reach anything else.
 * - Retries 429, 5xx and secondary rate limits (403 with `x-ratelimit-remaining: 0` or `retry-after`) up to 5 times,
 *   honouring `retry-after` and `x-ratelimit-reset` (capped), otherwise exponential back-off.
 * - A 401 invalidates the token once and retries with a fresh one; then `E_GITHUB_AUTH`.
 * - Errors carry a GitHub-style code and a message that never contains the token.
 */

/** Supplies the bearer token (from `gh auth token` or a secret reference); never logged. */
export interface TokenProvider {
  get(): Promise<string>;
  /** Called after a 401 so the next `get` fetches a fresh token. */
  invalidate(): void;
}

export type GitHubErrorCode =
  | 'E_GITHUB_AUTH'
  | 'E_GITHUB_PERMISSION'
  | 'E_GITHUB_NOT_FOUND'
  | 'E_GITHUB_RATE_LIMITED'
  | 'E_GITHUB_UNAVAILABLE'
  | 'E_GITHUB_FEATURE_UNAVAILABLE';

export class GitHubError extends Error {
  override readonly name = 'GitHubError';
  readonly code: GitHubErrorCode;
  readonly status: number | undefined;
  constructor(code: GitHubErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const SEG = '[A-Za-z0-9_.-]{1,100}';
/** Method + path patterns AutoTest may call (paths are relative to the API base, query strings excluded). */
export const ALLOWED_ENDPOINTS: readonly { readonly method: string; readonly path: RegExp }[] = [
  { method: 'GET', path: /^\/user$/ },
  { method: 'GET', path: new RegExp(`^/repos/${SEG}/${SEG}/pulls/\\d{1,9}$`) },
  { method: 'GET', path: new RegExp(`^/repos/${SEG}/${SEG}/pulls/\\d{1,9}/files$`) },
  { method: 'GET', path: new RegExp(`^/repos/${SEG}/${SEG}/issues/\\d{1,9}/comments$`) },
  { method: 'POST', path: new RegExp(`^/repos/${SEG}/${SEG}/issues/\\d{1,9}/comments$`) },
  { method: 'PATCH', path: new RegExp(`^/repos/${SEG}/${SEG}/issues/comments/\\d{1,20}$`) },
  { method: 'GET', path: new RegExp(`^/repos/${SEG}/${SEG}/commits/[0-9a-f]{40}/check-runs$`) },
  { method: 'POST', path: new RegExp(`^/repos/${SEG}/${SEG}/check-runs$`) },
  { method: 'PATCH', path: new RegExp(`^/repos/${SEG}/${SEG}/check-runs/\\d{1,20}$`) },
  { method: 'POST', path: new RegExp(`^/repos/${SEG}/${SEG}/statuses/[0-9a-f]{40}$`) },
];

export interface GitHubClientOptions {
  readonly token: TokenProvider;
  /** Default `https://api.github.com`; tests pass a local mock server. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxRetries?: number;
  /** Upper bound for one wait (default 60 s). */
  readonly maxWaitMs?: number;
  readonly userAgent?: string;
}

export interface GitHubResponse<T> {
  readonly status: number;
  readonly data: T;
  readonly headers: Headers;
}

export interface GitHubClient {
  request<T>(
    method: string,
    path: string,
    options?: { readonly query?: Record<string, string>; readonly body?: unknown },
  ): Promise<GitHubResponse<T>>;
  /** Follows `Link: rel="next"` until `max` items or no next page; reports whether it stopped early. */
  paginate<T>(
    path: string,
    options: { readonly max: number; readonly query?: Record<string, string> },
  ): Promise<{ items: T[]; truncated: boolean }>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createGitHubClient(o: GitHubClientOptions): GitHubClient {
  const base = (o.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? sleepReal;
  const maxRetries = o.maxRetries ?? 5;
  const maxWait = o.maxWaitMs ?? 60_000;

  const scrub = (text: string, token: string | undefined) =>
    (token ? text.split(token).join('[REDACTED:token]') : text)
      .replace(/gh[opsu]_[A-Za-z0-9]{20,}/g, '[REDACTED:token]')
      .slice(0, 300);

  async function call<T>(method: string, url: string, body: unknown): Promise<GitHubResponse<T>> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await o.token.get();
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': o.userAgent ?? 'mobile-autotest-mcp',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (e) {
        if (attempt < maxRetries) {
          await sleep(Math.min(maxWait, 500 * 2 ** attempt));
          continue;
        }
        throw new GitHubError('E_GITHUB_UNAVAILABLE', `GitHub is unreachable: ${scrub((e as Error).message, token)}`);
      }
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        // Not JSON (an HTML error page, for example): keep only the status.
      }
      if (res.ok) return { status: res.status, data: data as T, headers: res.headers };
      const apiMessage = scrub(String((data as { message?: unknown } | undefined)?.message ?? res.statusText), token);
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = res.headers.get('retry-after');
      const rateLimited = res.status === 429 || (res.status === 403 && (remaining === '0' || retryAfter !== null));
      if ((rateLimited || res.status >= 500) && attempt < maxRetries) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const wait = retryAfter
          ? Number(retryAfter) * 1000
          : remaining === '0' && reset
            ? reset * 1000 - Date.now()
            : 500 * 2 ** attempt;
        await sleep(Math.max(0, Math.min(maxWait, Number.isFinite(wait) ? wait : 1000)));
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        o.token.invalidate();
        continue;
      }
      if (rateLimited) throw new GitHubError('E_GITHUB_RATE_LIMITED', `GitHub rate limit: ${apiMessage}`, res.status);
      if (res.status === 401)
        throw new GitHubError('E_GITHUB_AUTH', `GitHub rejected the credential: ${apiMessage}`, 401);
      if (res.status === 403)
        throw new GitHubError('E_GITHUB_PERMISSION', `GitHub denied the request: ${apiMessage}`, 403);
      if (res.status === 404)
        throw new GitHubError('E_GITHUB_NOT_FOUND', `Not found on GitHub (or no access): ${apiMessage}`, 404);
      if (res.status >= 500)
        throw new GitHubError('E_GITHUB_UNAVAILABLE', `GitHub error ${res.status}: ${apiMessage}`, res.status);
      throw new GitHubError(
        'E_GITHUB_FEATURE_UNAVAILABLE',
        `GitHub refused the request (${res.status}): ${apiMessage}`,
        res.status,
      );
    }
  }

  const check = (method: string, path: string) => {
    if (!ALLOWED_ENDPOINTS.some((e) => e.method === method && e.path.test(path)))
      throw new GitHubError('E_GITHUB_FEATURE_UNAVAILABLE', `endpoint not allowed: ${method} ${path.slice(0, 120)}`);
  };
  const urlOf = (path: string, query?: Record<string, string>) =>
    `${base}${path}${query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : ''}`;

  return {
    async request<T>(method: string, path: string, options: { query?: Record<string, string>; body?: unknown } = {}) {
      check(method, path);
      return call<T>(method, urlOf(path, options.query), options.body);
    },
    async paginate<T>(path: string, options: { max: number; query?: Record<string, string> }) {
      check('GET', path);
      const items: T[] = [];
      let url: string | undefined = urlOf(path, { per_page: '100', ...options.query });
      while (url && items.length < options.max) {
        const res: GitHubResponse<T[]> = await call<T[]>('GET', url, undefined);
        items.push(...(Array.isArray(res.data) ? res.data : []));
        const next: string | undefined = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
        // Follow only links that stay on the same API base (a forged Link header cannot redirect the token).
        url = next && next.startsWith(`${base}/`) ? next : undefined;
      }
      return { items: items.slice(0, options.max), truncated: items.length > options.max || url !== undefined };
    },
  };
}
