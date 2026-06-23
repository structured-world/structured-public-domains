#!/usr/bin/env bash
# Build the wasm targets and assemble the npm package.
#
# Two glue layers are produced over a single shared wasm binary:
#   web    → ESM glue for browsers and ESM Node (async / top-level-await load)
#   nodejs → CommonJS glue for require()/NestJS consumers (synchronous load)
#
# Usage:
#   ./scripts/build-wasm.sh          # default release build
#   ./scripts/build-wasm.sh --dev    # unoptimised debug build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NPM_DIR="$ROOT/npm"
TMP_WEB="$(mktemp -d)"
TMP_NODE="$(mktemp -d)"
trap 'rm -rf "$TMP_WEB" "$TMP_NODE"' EXIT

PROFILE="--release"
if [[ "${1:-}" == "--dev" ]]; then
  PROFILE="--dev"
fi

# --- 1. Build both wasm targets ------------------------------------------------
wasm-pack build "$ROOT" --target web    --out-dir "$TMP_WEB"  $PROFILE -- --features wasm
wasm-pack build "$ROOT" --target nodejs --out-dir "$TMP_NODE" $PROFILE -- --features wasm

# The compiled module is identical across both targets, so the package ships a
# single .wasm. Guard that assumption: if a future wasm-pack ever diverges the
# two, fail loudly rather than silently pairing a glue with the wrong binary.
if ! cmp -s "$TMP_WEB/structured_public_domains_bg.wasm" \
            "$TMP_NODE/structured_public_domains_bg.wasm"; then
  echo "error: web and nodejs wasm binaries differ; cannot share one .wasm" >&2
  exit 1
fi

# --- 2. Copy artefacts into npm/ -----------------------------------------------
# Every artefact below is required: a missing file must fail the build loudly
# rather than silently producing a broken but publishable package.
#
# `--target web` inlines its glue into the main `.js` (no `_bg.js` shim). The
# nodejs glue is CommonJS, so it is renamed to `.cjs` (with a `.d.cts` sibling)
# so Node loads it as CommonJS under the package's "type": "module".
cp "$TMP_WEB/structured_public_domains_bg.wasm" "$NPM_DIR/"
cp "$TMP_WEB/structured_public_domains.js"      "$NPM_DIR/"
cp "$TMP_WEB/structured_public_domains.d.ts"    "$NPM_DIR/"
cp "$TMP_NODE/structured_public_domains.js"     "$NPM_DIR/structured_public_domains_node.cjs"
cp "$TMP_NODE/structured_public_domains.d.ts"   "$NPM_DIR/structured_public_domains_node.d.cts"

# --- 3. Sync version from Cargo.toml → package.json ----------------------------
CARGO_VERSION=$(grep '^version' "$ROOT/Cargo.toml" | head -1 | sed 's/.*"\(.*\)"/\1/')

# Use node if available, otherwise python, otherwise sed
if command -v node >/dev/null 2>&1; then
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$NPM_DIR/package.json', 'utf8'));
    p.version = '$CARGO_VERSION';
    fs.writeFileSync('$NPM_DIR/package.json', JSON.stringify(p, null, 2) + '\n');
  "
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "
import json, pathlib
p = pathlib.Path('$NPM_DIR/package.json')
d = json.loads(p.read_text())
d['version'] = '$CARGO_VERSION'
p.write_text(json.dumps(d, indent=2) + '\n')
"
else
  sed -i.bak "s/\"version\": \".*\"/\"version\": \"$CARGO_VERSION\"/" "$NPM_DIR/package.json"
  rm -f "$NPM_DIR/package.json.bak"
fi

echo "wasm build complete — npm package ready in npm/"
echo "  version: $CARGO_VERSION"
echo "  wasm:    $(du -h "$NPM_DIR/structured_public_domains_bg.wasm" | cut -f1 | xargs)"
