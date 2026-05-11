#!/usr/bin/env sh
# mavis-pet one-shot installer.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<your-org>/mavis-pet/main/install.sh | sh
#
# What it does:
#   1. npm i -g mavis-pet @mavis-pet/broker
#   2. download the floater binary for your platform from GitHub Releases
#      to ~/.mavis/pet/floater
#   3. print next steps

set -eu

REPO="${MAVIS_PET_REPO:-vinozhong33/mavis-pet}"
VERSION="${MAVIS_PET_VERSION:-latest}"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64)  PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64"   ;;
  *) echo "mavis-pet: $OS-$ARCH not yet supported (only macOS Apple Silicon for now)"; exit 1 ;;
esac

echo "==> installing mavis-pet (npm)"
if ! command -v npm >/dev/null 2>&1; then
  echo "FAIL: npm not found. install Node.js 18+ first."; exit 1
fi
npm i -g mavis-pet @mavis-pet/broker

echo "==> downloading floater binary ($PLATFORM)"
mkdir -p "$HOME/.mavis/pet"
TMP="$(mktemp -d)"

if [ "$VERSION" = "latest" ]; then
  ZIP_URL="https://github.com/$REPO/releases/latest/download/mavis-pet-floater-${PLATFORM}.zip"
else
  ZIP_URL="https://github.com/$REPO/releases/download/$VERSION/mavis-pet-floater-${VERSION}-${PLATFORM}.zip"
fi

if ! curl -fsSL "$ZIP_URL" -o "$TMP/floater.zip"; then
  echo "FAIL: cannot download $ZIP_URL"
  echo "If this is the first release, build locally:"
  echo "  git clone https://github.com/$REPO ~/mavis-pet && cd ~/mavis-pet && ./scripts/build-floater.sh"
  exit 1
fi

unzip -q -o "$TMP/floater.zip" -d "$TMP/extract"
cp "$TMP/extract/floater" "$HOME/.mavis/pet/floater"
chmod +x "$HOME/.mavis/pet/floater"
rm -rf "$TMP"

echo ""
echo "==> done. next steps:"
echo "  mavis-pet install boba       # pick a pet from petdex gallery"
echo "  mavis-pet hook install       # register 3 mavis hooks (one-time)"
echo "  mavis-pet start              # launch broker + floater"
echo ""
echo "Then any mavis bash/tool call will animate the pet on your screen."
