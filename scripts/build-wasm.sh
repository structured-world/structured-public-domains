#!/usr/bin/env bash
# Build the wasm target and assemble the npm package.
#
# Usage:
#   ./scripts/build-wasm.sh          # default release build
#   ./scripts/build-wasm.sh --dev    # unoptimised debug build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NPM_DIR="$ROOT/npm"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PROFILE="--release"
if [[ "${1:-}" == "--dev" ]]; then
  PROFILE="--dev"
fi

# --- 1. Build with wasm-pack ---------------------------------------------------
wasm-pack build "$ROOT" \
  --target web \
  --out-dir "$TMP_DIR" \
  $PROFILE \
  -- --features wasm

# --- 2. Copy artefacts into npm/ -----------------------------------------------
cp "$TMP_DIR/structured_public_domains_bg.wasm" "$NPM_DIR/"
cp "$TMP_DIR/structured_public_domains.js"      "$NPM_DIR/"
cp "$TMP_DIR/structured_public_domains_bg.js"   "$NPM_DIR/" 2>/dev/null || true
cp "$TMP_DIR/structured_public_domains.d.ts"    "$NPM_DIR/structured_public_domains.d.ts" 2>/dev/null || true

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
