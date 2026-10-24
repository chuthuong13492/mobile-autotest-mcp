#!/usr/bin/env bash
# REL-001 install smoke (CI and local): installs the release tarball into a temporary npm prefix with a temporary
# HOME, runs `autotest setup` (without Claude Code) and `autotest doctor`, and checks that `autotest-mcp` answers the
# MCP handshake with all 18 tools. Needs no Flutter SDK. Usage: scripts/install-smoke.sh <tarball>
set -euo pipefail
TGZ=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home" npm_config_cache="$WORK/npm-cache"
mkdir -p "$HOME"
npm install -g --prefix "$WORK/prefix" "$TGZ" >/dev/null
BIN="$WORK/prefix/bin"
cp -R "$ROOT/fixtures/fixture-flutter" "$WORK/app"
"$BIN/autotest" setup --yes --skip-claude --workspace "$WORK/app"
"$BIN/autotest" doctor
node - "$BIN/autotest-mcp" <<'JS'
const { spawn } = require('node:child_process');
const p = spawn(process.execPath, [process.argv[2]], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const want = new Map();
p.stdout.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    want.get(m.id)?.(m.result);
  }
});
const send = (id, method, params) =>
  new Promise((r) => {
    want.set(id, r);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
(async () => {
  const init = await send(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'install-smoke', version: '0' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await send(2, 'tools/list', {});
  const n = tools.tools.length;
  console.log(`autotest-mcp ${init.serverInfo.version}: ${n} tools`);
  p.stdin.end();
  process.exit(n === 18 ? 0 : 1);
})();
JS
echo "install smoke: PASS"
