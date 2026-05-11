#!/usr/bin/env bash
# build floater release artifact for the current platform.
# Output: release/mavis-pet-floater-<version>-<platform>.zip
#
# Run from repo root:  ./scripts/build-floater.sh
#
# Currently supports macOS (Apple Silicon and Intel separately).
# Linux/Windows: TODO — Tauri supports them; needs spike.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/packages/floater"

VERSION="$(jq -r .version ../cli/package.json 2>/dev/null || echo "0.1.0")"

PLATFORM=""
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64"   ;;
  Linux-x86_64)  PLATFORM="linux-x64"    ;;
  Linux-aarch64) PLATFORM="linux-arm64"  ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)"; exit 1 ;;
esac

echo "==> building floater release for $PLATFORM (v$VERSION)"
. "$HOME/.cargo/env" 2>/dev/null || true
cargo build --release

BIN="target/release/mavis-pet-floater"
if [ ! -x "$BIN" ]; then
  echo "FAIL: $BIN missing after build"; exit 1
fi

OUT_DIR="$ROOT/release"
mkdir -p "$OUT_DIR"
ZIP_NAME="mavis-pet-floater-v${VERSION}-${PLATFORM}.zip"

# Stage a flat dir then zip. The user installs by copying the binary to
# ~/.mavis/pet/floater (the path mavis-pet CLI auto-detects).
STAGE="$(mktemp -d)"
cp "$BIN" "$STAGE/floater"
chmod +x "$STAGE/floater"

# include a one-line README in the zip
cat > "$STAGE/README.txt" << EOF
mavis-pet floater binary v${VERSION} (${PLATFORM})

To install:
  mkdir -p ~/.mavis/pet
  unzip -o $ZIP_NAME -d ~/.mavis/pet/

Then 'mavis-pet start' will pick it up automatically.
Or set MAVIS_PET_FLOATER=/path/to/floater env var to override.
EOF

(cd "$STAGE" && zip -q -r "$OUT_DIR/$ZIP_NAME" .)
rm -rf "$STAGE"

echo "==> wrote $OUT_DIR/$ZIP_NAME"
ls -lh "$OUT_DIR/$ZIP_NAME"
