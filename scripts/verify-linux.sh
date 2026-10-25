#!/usr/bin/env bash
# M8 Linux verification: in a clean container with a Flutter SDK, install Node 24 (official tarball) and procps,
# install the release tarball, run `autotest setup --skip-claude`, `autotest doctor` and the release smoke test with a
# real Flutter run. Needs a running Docker daemon and network access for the image and the Node download.
# Usage: scripts/verify-linux.sh [tarball]   Env: FLUTTER_IMAGE (default ghcr.io/cirruslabs/flutter:3.47.1)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TGZ=${1:-$ROOT/release/out/mobile-autotest-mcp-1.1.1.tgz}
IMAGE=${FLUTTER_IMAGE:-ghcr.io/cirruslabs/flutter:3.47.1}
docker run --rm --user root \
  -v "$TGZ":/pkg/autotest.tgz:ro \
  -v "$ROOT/fixtures/fixture-flutter":/fixture:ro \
  -v "$ROOT/scripts/release-smoke.mjs":/smoke.mjs:ro \
  "$IMAGE" bash -euo pipefail -c '
    apt-get update -qq >/dev/null && apt-get install -y -qq procps curl xz-utils >/dev/null
    case "$(uname -m)" in x86_64) a=x64 ;; aarch64) a=arm64 ;; *) echo "unsupported arch"; exit 1 ;; esac
    file=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o "node-v24[^ ]*-linux-$a.tar.xz" | head -1)
    curl -fsSL "https://nodejs.org/dist/latest-v24.x/$file" | tar -xJ -C /opt
    export PATH="/opt/${file%.tar.xz}/bin:$PATH"
    node --version
    npm install -g /pkg/autotest.tgz >/dev/null
    cp -r /fixture /app && cp /app/test_scenarios/flaky_test.dart /app/test/
    (cd /app && (flutter pub get --offline || flutter pub get) >/dev/null)
    autotest setup --yes --skip-claude --workspace /app --flutter "$(readlink -f "$(command -v flutter)")"
    autotest doctor || true
    node /smoke.mjs "$(npm prefix -g)/lib/node_modules/mobile-autotest-mcp/dist/autotest-mcp.mjs"
    autotest doctor --audit
  '
echo "Linux verification: PASS ($IMAGE)"
