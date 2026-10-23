/**
 * Release build (M7; REL-001 subset, SEC-005 subset). `node scripts/build-release.ts [--pack]`
 *
 * Produces `release/out/package/`, an npm package with no runtime dependencies:
 * - `dist/autotest-mcp.mjs`, `dist/autotest.mjs`: bins. Each refuses Node < 24 with a clear message, then loads its
 *   bundle (`server.bundle.mjs`, `cli.bundle.mjs`), so the version check runs before `node:sqlite` is imported.
 * - `dist/supervisor.mjs`: the detached run supervisor (started by the server with its own Node).
 * - `skills/pr-mobile-autotest/`, `plugin/` (Claude Code plugin with the Skill), README, CHANGELOG, LICENSE notes.
 * - `sbom.cdx.json` (CycloneDX 1.5) and `THIRD_PARTY_LICENSES.md`, both from the packages esbuild actually bundled.
 * With `--pack`: `npm pack` into `release/out/` and `SHA256SUMS` for the tarball.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build, type Metafile } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
/** Output folder; `AUTOTEST_RELEASE_OUT` overrides it (tests build into a temporary folder). */
const OUT = process.env['AUTOTEST_RELEASE_OUT'] ?? path.join(ROOT, 'release', 'out');
const PKG = path.join(OUT, 'package');
const DIST = path.join(PKG, 'dist');
const version = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const compose = fs.readFileSync(path.join(ROOT, 'apps/mcp-server/src/compose.ts'), 'utf8');
if (!compose.includes(`SERVER_VERSION = '${version}'`))
  throw new Error(`SERVER_VERSION in compose.ts must equal package.json version ${version}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const result = await build({
  entryPoints: {
    'server.bundle': path.join(ROOT, 'apps/mcp-server/src/main.ts'),
    'cli.bundle': path.join(ROOT, 'apps/cli/src/main.ts'),
    supervisor: path.join(ROOT, 'apps/mcp-server/src/supervisorBoot.ts'),
  },
  outdir: DIST,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  define: { AUTOTEST_BUNDLE: 'true' },
  banner: {
    js: "import { createRequire as __autotestRequire } from 'node:module';\nconst require = __autotestRequire(import.meta.url);",
  },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

const guard = (bundle: string) => `#!/usr/bin/env node
// Mobile AutoTest MCP ${version}: refuse unsupported Node versions before anything else loads.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  process.stderr.write(\`autotest needs Node.js 24 or newer; this is \${process.version} (\${process.execPath}).\\n\`);
  process.exit(1);
}
await import('./${bundle}');
`;
fs.writeFileSync(path.join(DIST, 'autotest-mcp.mjs'), guard('server.bundle.mjs'), { mode: 0o755 });
fs.writeFileSync(path.join(DIST, 'autotest.mjs'), guard('cli.bundle.mjs'), { mode: 0o755 });

// ---- third-party inventory from the bundle inputs
interface ThirdParty {
  name: string;
  version: string;
  license: string;
  dir: string;
}
function thirdParty(meta: Metafile): ThirdParty[] {
  const dirs = new Set<string>();
  for (const input of Object.keys(meta.inputs)) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (m) dirs.add(path.resolve(ROOT, m[1]!));
  }
  return [...dirs]
    .map((dir) => {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        license?: string;
      };
      return { name: pj.name, version: pj.version, license: pj.license ?? 'UNKNOWN', dir };
    })
    .filter((p) => !p.name.startsWith('@autotest/'))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}
const deps = thirdParty(result.metafile);
const allowed = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|Python-2\.0)$/;
const bad = deps.filter((d) => !allowed.test(d.license));
if (bad.length)
  throw new Error(
    `bundled packages with unreviewed licenses: ${bad.map((d) => `${d.name}@${d.version} (${d.license})`).join(', ')}`,
  );

const licenseText = (dir: string) => {
  const files = fs.readdirSync(dir);
  const f = files.find((n) => /^(LICEN[CS]E|COPYING)(\.|$)/i.test(n));
  const notice = files.find((n) => /^NOTICE(\.|$)/i.test(n));
  const text = f
    ? fs.readFileSync(path.join(dir, f), 'utf8').trim()
    : '(no license file in the package; see its package.json)';
  return notice ? `${text}\n\n--- NOTICE ---\n${fs.readFileSync(path.join(dir, notice), 'utf8').trim()}` : text;
};
fs.writeFileSync(
  path.join(PKG, 'THIRD_PARTY_LICENSES.md'),
  `# Third-party licenses\n\nThe bundles in \`dist/\` include these packages.\n\n${deps
    .map((d) => `## ${d.name} ${d.version} (${d.license})\n\n\`\`\`text\n${licenseText(d.dir)}\n\`\`\`\n`)
    .join('\n')}`,
);
fs.writeFileSync(
  path.join(PKG, 'sbom.cdx.json'),
  `${JSON.stringify(
    {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        component: { type: 'application', name: 'mobile-autotest-mcp', version },
        tools: { components: [{ type: 'application', name: 'scripts/build-release.ts' }] },
      },
      components: deps.map((d) => ({
        type: 'library',
        name: d.name,
        version: d.version,
        purl: `pkg:npm/${d.name.replace('@', '%40')}@${d.version}`,
        licenses: [{ license: { id: d.license } }],
      })),
    },
    null,
    2,
  )}\n`,
);

// ---- package files
fs.cpSync(path.join(ROOT, 'skills'), path.join(PKG, 'skills'), { recursive: true });
fs.cpSync(path.join(ROOT, 'plugin'), path.join(PKG, 'plugin'), { recursive: true });
fs.rmSync(path.join(PKG, 'plugin', 'README.md'));
fs.cpSync(path.join(ROOT, 'skills', 'pr-mobile-autotest'), path.join(PKG, 'plugin', 'skills', 'pr-mobile-autotest'), {
  recursive: true,
});
for (const f of ['CHANGELOG.md']) fs.copyFileSync(path.join(ROOT, 'release', f), path.join(PKG, f));
fs.copyFileSync(path.join(ROOT, 'release', 'INSTALL.md'), path.join(PKG, 'README.md'));
fs.writeFileSync(
  path.join(PKG, 'package.json'),
  `${JSON.stringify(
    {
      name: 'mobile-autotest-mcp',
      version,
      description:
        'PR-driven, policy-governed mobile test orchestration for Claude Code: MCP server, CLI and Agent Skill.',
      type: 'module',
      license: 'UNLICENSED',
      private: true,
      engines: { node: '>=24' },
      os: ['darwin', 'linux'],
      bin: { 'autotest-mcp': 'dist/autotest-mcp.mjs', autotest: 'dist/autotest.mjs' },
      files: ['dist', 'skills', 'plugin', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY_LICENSES.md', 'sbom.cdx.json'],
    },
    null,
    2,
  )}\n`,
);

const size = (f: string) => `${Math.round(fs.statSync(path.join(DIST, f)).size / 1024)} KiB`;
console.log(
  `built ${PKG} (v${version}): server ${size('server.bundle.mjs')}, cli ${size('cli.bundle.mjs')}, supervisor ${size('supervisor.mjs')}; ${deps.length} bundled third-party packages`,
);

if (process.argv.includes('--pack')) {
  // pnpm exports npm_config_* for its own settings; npm warns about them, so they are dropped here.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith('npm_config_')),
  );
  const out = execFileSync('npm', ['pack', '--pack-destination', OUT, '--json'], { cwd: PKG, encoding: 'utf8', env });
  const file = (JSON.parse(out) as { filename: string }[])[0]!.filename;
  const tgz = path.join(OUT, file);
  const sum = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS'), `${sum}  ${file}\n`);
  fs.copyFileSync(path.join(PKG, 'sbom.cdx.json'), path.join(OUT, `${file.replace(/\.tgz$/, '')}.sbom.cdx.json`));
  console.log(`packed ${tgz}\nsha256 ${sum}`);
}
