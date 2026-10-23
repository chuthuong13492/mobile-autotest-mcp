// Dependency-boundary rules (OPS-003, ADR-0015). Generated from boundaries.json, the machine-readable twin of
// docs/architecture.md §Packages and dependency rules. Change boundaries.json + the doc + ADR-0015 together.
/* eslint-disable */
const boundaries = require('./boundaries.json');

const units = Object.keys(boundaries).filter((k) => !k.startsWith('$'));
const pkgName = (dir) => dir.split('/')[1];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One rule per workspace unit: it may import only itself and its allowed @autotest packages. */
const allowedPackageRules = units.map((unit) => {
  const allowed = boundaries[unit] === '*' ? units.filter((u) => u.startsWith('packages/')) : boundaries[unit];
  const ok = [unit, ...allowed].map((d) => `${esc(d)}/`).join('|');
  return {
    name: `allowed-package-deps:${unit}`,
    severity: 'error',
    comment: `${unit} may only import: ${allowed.join(', ') || '(no workspace packages)'} (boundaries.json)`,
    from: { path: `^${esc(unit)}/` },
    to: { path: '^(packages|apps)/[^/]+/', pathNot: `^(${ok})` },
  };
});

const SIDE_EFFECT_CORE = '^(node:)?(child_process|fs|fs/promises|net|http|https|http2|dgram|tls|dns)$';
const PURE_UNITS = '^packages/(adapter-[^/]+|planning|coverage-gate|analysis)/';

module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', comment: 'No dependency cycles.', from: {}, to: { circular: true } },
    {
      name: 'no-apps-import',
      severity: 'error',
      comment: 'Packages must never import apps.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'coverage-gate-not-planning',
      severity: 'error',
      comment: 'ADR-0005: the coverage gate must not depend on planning, directly or transitively.',
      from: { path: '^packages/coverage-gate/' },
      to: { path: '^packages/planning/', reachable: true },
    },
    {
      name: 'adapters-isolated',
      severity: 'error',
      comment: 'ADR-0009: adapters never import one another.',
      from: { path: '^packages/(adapter-(?!sdk/)[^/]+)/' },
      to: { path: '^packages/adapter-(?!sdk/)[^/]+/', pathNot: '^packages/$1/' },
    },
    {
      name: 'adapters-no-side-effects',
      severity: 'error',
      comment:
        'ADR-0009/0015: adapters, planning, coverage-gate and analysis are pure (no process, fs or network modules).',
      from: { path: PURE_UNITS },
      to: { dependencyTypes: ['core'], path: SIDE_EFFECT_CORE },
    },
    {
      name: 'pure-units-no-network-libs',
      severity: 'error',
      comment: 'ADR-0015: pure units may not use HTTP client libraries.',
      from: { path: PURE_UNITS },
      to: { path: '(^|/)node_modules/(undici|node-fetch|axios|got)/|^(undici|node-fetch|axios|got)$' },
    },
    {
      name: 'only-exec-spawns',
      severity: 'error',
      comment: 'ADR-0014: only packages/exec may import child_process.',
      from: { pathNot: '^packages/exec/' },
      to: { dependencyTypes: ['core'], path: '^(node:)?child_process$' },
    },
    {
      name: 'only-github-network',
      severity: 'error',
      comment: 'ADR-0013/0015: only packages/github may import @octokit/*.',
      from: { pathNot: '^packages/github/' },
      to: { path: '(^|/)node_modules/@octokit/|^@octokit/' },
    },
    {
      name: 'sdk-only-in-app',
      severity: 'error',
      comment: 'ADR-0001: only apps/mcp-server may import the MCP SDK.',
      from: { pathNot: '^apps/mcp-server/' },
      to: { path: '(^|/)node_modules/@modelcontextprotocol/|^@modelcontextprotocol/' },
    },
    {
      name: 'no-llm-sdks',
      severity: 'error',
      comment: 'ADR-0004: no LLM SDKs anywhere in Release 1.',
      from: {},
      to: {
        path: '(^|/)node_modules/(@anthropic-ai|openai|@google/generative-ai|@google/genai|@mistralai|cohere-ai|ollama)(/|$)|^(@anthropic-ai|openai|@google/generative-ai|@google/genai|@mistralai|cohere-ai|ollama)(/|$)',
      },
    },
    {
      name: 'no-deep-imports',
      severity: 'error',
      comment:
        'Cross-package imports go through a package entrypoint only: src/index.ts, or src/testing/index.ts for test fakes and contract kits.',
      from: { path: '^(packages|apps)/([^/]+)/' },
      to: {
        path: '^(packages|apps)/[^/]+/',
        pathNot: ['^$1/$2/', '^(packages|apps)/[^/]+/src/(index|testing/index)\\.ts$'],
      },
    },
    ...allowedPackageRules,
  ],
  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    // node_modules is NOT excluded: npm targets must stay visible so SDK/Octokit/LLM rules can fire.
    exclude: { path: '^packages/contracts/schemas/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.cjs', '.mjs', '.json'],
    },
  },
};
