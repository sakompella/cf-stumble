#!/usr/bin/env bash
# Re-derive vendor/cloudflare-computer-0.3.0.tgz from source and compare checksums.
#
# Usage:
#   scripts/vendor/verify-computer-tarball.sh
#
# Exits 0 if the freshly built tarball matches the vendored checksum, 1 otherwise.

set -euo pipefail

COMMIT="12336475c9fd03f5280a4537a707797fc0131fbd"
EXPECTED_CHECKSUM="$(awk '!/^#/{print $1}' "$(dirname "$0")/../../.audit/evidence/computer-tarball-checksum.txt")"
WORKDIR="$(mktemp -d)"

cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

echo "Cloning cloudflare/computer into $WORKDIR ..."
git clone --quiet https://github.com/cloudflare/computer.git "$WORKDIR/computer"
cd "$WORKDIR/computer"
git fetch origin "$COMMIT" 2>/dev/null || true
git checkout --quiet "$COMMIT"

echo "Installing dependencies ..."
npm ci --quiet 2>&1

echo "Building ..."
npm run build --quiet 2>&1

echo "Packing ..."
npm pack --workspace @cloudflare/computer --quiet 2>&1

TARBALL="$WORKDIR/computer/cloudflare-computer-0.3.0.tgz"
if [ ! -f "$TARBALL" ]; then
  echo "ERROR: tarball not produced at $TARBALL"
  exit 1
fi

ACTUAL_CHECKSUM="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"

echo ""
echo "Expected: $EXPECTED_CHECKSUM"
echo "Actual:   $ACTUAL_CHECKSUM"

if [ "$EXPECTED_CHECKSUM" = "$ACTUAL_CHECKSUM" ]; then
  echo "PASS: checksums match."
  exit 0
else
  echo "FAIL: checksums differ."
  echo ""
  echo "Comparing tarball contents ..."
  VENDORED="$(cd "$(dirname "$0")/../.." && pwd)/vendor/cloudflare-computer-0.3.0.tgz"
  diff <(tar tzf "$VENDORED" | sort) <(tar tzf "$TARBALL" | sort) || true
  echo ""
  echo "Comparing file sizes ..."
  diff <(tar tvf "$VENDORED" | awk '{print $NF, $3}' | sort) \
       <(tar tvf "$TARBALL" | awk '{print $NF, $3}' | sort) || true
  exit 1
fi
