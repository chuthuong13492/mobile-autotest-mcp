#!/usr/bin/env bash
# M8 macOS verification: install the release tarball into a temporary npm prefix with a temporary HOME, then run
# `autotest setup` (registering with Claude Code inside that HOME only), `autotest doctor` and the release smoke test
# with a real Flutter SDK. Usage: scripts/verify-macos.sh <flutter> [tarball]   (run with Node 24+ on PATH)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FLUTTER=${1:?usage: verify-macos.sh /abs/path/to/flutter [tarball]}
TGZ=${2:-$ROOT/release/out/mobile-autotest-mcp-1.1.1.tgz}
WORK=$(mktemp -d)
mkdir -p "$WORK/home" "$WORK/prefix"
cp -R "$ROOT/fixtures/fixture-flutter" "$WORK/app"
cp "$WORK/app/test_scenarios/flaky_test.dart" "$WORK/app/test/"
(cd "$WORK/app" && "$FLUTTER" pub get --offline >/dev/null)
NODE_BIN=$(dirname "$(command -v node)")
export HOME="$WORK/home"
npm install -g "$TGZ" --prefix "$WORK/prefix" >/dev/null
export PATH="$WORK/prefix/bin:$NODE_BIN:$(dirname "$(command -v claude 2>/dev/null || echo /usr/bin/true)"):/usr/bin:/bin"
autotest setup --yes --workspace "$WORK/app" --flutter "$FLUTTER"
autotest doctor
node "$ROOT/scripts/release-smoke.mjs" "$WORK/prefix/lib/node_modules/mobile-autotest-mcp/dist/autotest-mcp.mjs"
autotest doctor --audit
echo "macOS verification: PASS ($WORK)"
