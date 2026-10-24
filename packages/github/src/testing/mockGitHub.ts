/**
 * In-memory GitHub API for tests (node:http on 127.0.0.1). Implements exactly the endpoints the client allows, with
 * PRs, changed files, issue comments, check runs and statuses as state, a required bearer token, and injectable
 * failures (status queues per route, check runs forbidden as for a `gh` user token).
 */
import http from 'node:http';

export interface MockPr {
  title: string;
  body: string;
  labels?: string[];
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  files: { filename: string; status?: string; additions?: number; deletions?: number }[];
}

export interface MockGitHubOptions {
  readonly token: string;
  readonly login?: string;
  /** Check-run endpoints answer 403 (a user OAuth token cannot create check runs). */
  readonly checksForbidden?: boolean;
}

export interface MockGitHub {
  readonly url: string;
  readonly prs: Map<string, MockPr>;
  readonly comments: { id: number; issue: string; body: string; user: { login: string } }[];
  readonly checkRuns: {
    id: number;
    repo: string;
    head_sha: string;
    external_id: string;
    conclusion: string;
    annotations: number;
    output: unknown;
  }[];
  readonly statuses: { repo: string; sha: string; state: string; context: string; description: string }[];
  readonly requests: { method: string; path: string; authorized: boolean }[];
  /** Pending status codes per `METHOD path-pattern` (consumed in order) to simulate 429/5xx. */
  readonly failures: Map<string, { status: number; headers?: Record<string, string> }[]>;
  close(): Promise<void>;
}

export async function startMockGitHub(o: MockGitHubOptions): Promise<MockGitHub> {
  const login = o.login ?? 'autotest-user';
  let nextId = 1000;
  const state: Omit<MockGitHub, 'url' | 'close'> = {
    prs: new Map(),
    comments: [],
    checkRuns: [],
    statuses: [],
    requests: [],
    failures: new Map(),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const authorized = req.headers.authorization === `Bearer ${o.token}`;
    state.requests.push({ method, path, authorized });
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString('utf8')));
    req.on('end', () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      if (!authorized) return send(401, { message: 'Bad credentials' });
      for (const [key, queue] of state.failures) {
        const [m, p] = key.split(' ');
        if (m === method && new RegExp(p!).test(path) && queue.length) {
          const f = queue.shift()!;
          return send(f.status, { message: `simulated ${f.status}` }, f.headers ?? {});
        }
      }
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      let m: RegExpExecArray | null;
      if (method === 'GET' && path === '/user') return send(200, { login });
      if ((m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(path)) && method === 'GET') {
        const pr = state.prs.get(`${m[1]}/${m[2]}#${m[3]}`);
        if (!pr) return send(404, { message: 'Not Found' });
        return send(200, {
          title: pr.title,
          body: pr.body,
          labels: (pr.labels ?? []).map((name) => ({ name })),
          state: 'open',
          draft: false,
          head: pr.head,
          base: pr.base,
          changed_files: pr.files.length,
          html_url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`,
        });
      }
      const page = (items: unknown[]) => {
        const per = Number(url.searchParams.get('per_page') ?? 30);
        const n = Number(url.searchParams.get('page') ?? 1);
        const slice = items.slice((n - 1) * per, n * per);
        const headers: Record<string, string> = {};
        if (n * per < items.length) {
          const next = new URL(url.toString());
          next.searchParams.set('page', String(n + 1));
          headers['link'] = `<${mock.url}${next.pathname}${next.search}>; rel="next"`;
        }
        return send(200, slice, headers);
      };
      if ((m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/.exec(path)) && method === 'GET') {
        const pr = state.prs.get(`${m[1]}/${m[2]}#${m[3]}`);
        return pr ? page(pr.files.slice(0, 3000)) : send(404, { message: 'Not Found' });
      }
      if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(path))) {
        const issue = `${m[1]}/${m[2]}#${m[3]}`;
        if (method === 'GET')
          return page(
            state.comments
              .filter((c) => c.issue === issue)
              .map((c) => ({ ...c, html_url: `https://github.com/c/${c.id}` })),
          );
        const c = { id: nextId++, issue, body: String(body['body']), user: { login } };
        state.comments.push(c);
        return send(201, { ...c, html_url: `https://github.com/c/${c.id}` });
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path)) && method === 'PATCH') {
        const c = state.comments.find((x) => x.id === Number(m![1]));
        if (!c) return send(404, { message: 'Not Found' });
        c.body = String(body['body']);
        return send(200, { ...c, html_url: `https://github.com/c/${c.id}` });
      }
      if (/\/check-runs/.test(path) && o.checksForbidden)
        return send(403, { message: 'You must authenticate via a GitHub App.' });
      if ((m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{40})\/check-runs$/.exec(path)) && method === 'GET')
        return send(200, {
          check_runs: state.checkRuns.filter((c) => c.repo === `${m![1]}/${m![2]}` && c.head_sha === m![3]),
        });
      if ((m = /^\/repos\/([^/]+)\/([^/]+)\/check-runs$/.exec(path)) && method === 'POST') {
        const output = body['output'] as { annotations?: unknown[] } | undefined;
        if ((output?.annotations?.length ?? 0) > 50) return send(422, { message: 'too many annotations' });
        const c = {
          id: nextId++,
          repo: `${m[1]}/${m[2]}`,
          head_sha: String(body['head_sha']),
          external_id: String(body['external_id']),
          conclusion: String(body['conclusion']),
          annotations: output?.annotations?.length ?? 0,
          output,
        };
        state.checkRuns.push(c);
        return send(201, { ...c, html_url: `https://github.com/runs/${c.id}` });
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/.exec(path)) && method === 'PATCH') {
        const c = state.checkRuns.find((x) => x.id === Number(m![1]));
        if (!c) return send(404, { message: 'Not Found' });
        const output = body['output'] as { annotations?: unknown[] } | undefined;
        if ((output?.annotations?.length ?? 0) > 50) return send(422, { message: 'too many annotations' });
        c.annotations += output?.annotations?.length ?? 0;
        if (body['conclusion']) c.conclusion = String(body['conclusion']);
        return send(200, { ...c, html_url: `https://github.com/runs/${c.id}` });
      }
      if ((m = /^\/repos\/([^/]+)\/([^/]+)\/statuses\/([0-9a-f]{40})$/.exec(path)) && method === 'POST') {
        const s = {
          repo: `${m[1]}/${m[2]}`,
          sha: m[3]!,
          state: String(body['state']),
          context: String(body['context']),
          description: String(body['description']),
        };
        state.statuses.push(s);
        return send(201, { id: nextId++, ...s });
      }
      return send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address() as { port: number };
  const mock: MockGitHub = {
    ...state,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  return mock;
}
