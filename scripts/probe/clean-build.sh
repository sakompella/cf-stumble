#!/usr/bin/env bash
#
# Clean-build probe for a labeled harness commit.
#
# The local `pnpm verify` gate builds Pi before anything reads it, so a developer machine always
# has `vendor/pi-v0.84.4/dist/` and a populated `node_modules` in place. The Supervisor's build
# runs `HARNESS_BUILD_CONFIGURATION.buildCommand` in a directory that `git archive` just wrote, so
# it has neither. This script reproduces that starting state locally: it extracts a commit into a
# temporary directory outside the repository, isolates HOME and the pnpm store, and runs the same
# `build:artifact` script the Supervisor runs.
#
# It builds the commit twice into separate directories with separate stores and compares the two
# module maps byte for byte. That is a fast pre-check for goal criterion 7, NOT the criterion
# itself: criterion 7 requires two clean builds inside Computer, which this script never touches.
#
# Usage:
#   scripts/probe/clean-build.sh [commit-ish]     # default: HEAD
#
# Environment:
#   CLEAN_BUILD_KEEP=1   keep the temporary directory for inspection
#
# It makes no Cloudflare API call, creates no workspace, and spends nothing beyond npm registry
# downloads.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMITTISH="${1:-HEAD}"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify "${COMMITTISH}^{commit}")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-stumble-clean-build.XXXXXXXX")"
cleanup() {
  if [ "${CLEAN_BUILD_KEEP:-0}" = "1" ]; then
    printf 'Kept %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

printf 'Clean build of %s\n' "$COMMIT"
printf 'Work directory: %s\n' "$WORK"

ARCHIVE="${WORK}/source.tar"
git -C "$REPO_ROOT" archive --format=tar -o "$ARCHIVE" "$COMMIT"
printf 'Archive bytes: %s\n' "$(wc -c <"$ARCHIVE" | tr -d ' ')"

# One build. The caller's HOME, npm configuration, pnpm store and NODE_PATH are all replaced, and
# the build directory lives outside the repository, so no parent directory offers a node_modules
# to borrow.
run_build() {
  local index="$1"
  local directory="${WORK}/build-${index}"
  local home="${WORK}/home-${index}"

  mkdir -p "$directory" "$home"
  tar -x -C "$directory" -f "$ARCHIVE"

  if [ -e "${directory}/node_modules" ] || [ -e "${directory}/vendor/pi-v0.84.4/dist" ]; then
    printf 'The extracted commit already contains build output; the probe would prove nothing\n' >&2
    return 1
  fi

  local started ended
  started="$(date +%s)"
  (
    cd "$directory"
    env -i \
      PATH="$PATH" \
      HOME="$home" \
      TMPDIR="${TMPDIR:-/tmp}" \
      SHELL="${SHELL:-/bin/bash}" \
      npm_config_userconfig="${home}/.npmrc" \
      npm_config_globalconfig="${home}/.npmrc.global" \
      pnpm run build:artifact
  ) >"${WORK}/build-${index}.log" 2>&1 || {
    printf 'Build %s failed. Last 40 log lines:\n' "$index" >&2
    tail -40 "${WORK}/build-${index}.log" >&2
    return 1
  }
  ended="$(date +%s)"

  local map="${directory}/build/module-map.json"
  if [ ! -s "$map" ]; then
    printf 'Build %s produced no module map at %s\n' "$index" "$map" >&2
    return 1
  fi

  # pnpm derives the content-addressable store from HOME, so the isolated HOME is the store: its
  # size is what a cold container downloads, and the build directory is what the build occupies.
  printf 'Build %s: %s seconds, module map %s bytes, build directory %s, cold store %s\n' \
    "$index" "$((ended - started))" "$(wc -c <"$map" | tr -d ' ')" \
    "$(du -sh "$directory" | cut -f1)" \
    "$(du -sh "$home" | cut -f1)"
}

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

run_build 1
run_build 2

MAP_1="${WORK}/build-1/build/module-map.json"
MAP_2="${WORK}/build-2/build/module-map.json"
DIGEST_1="$(digest "$MAP_1")"
DIGEST_2="$(digest "$MAP_2")"

printf 'Module map sha256 (build 1): %s\n' "$DIGEST_1"
printf 'Module map sha256 (build 2): %s\n' "$DIGEST_2"

if ! cmp -s "$MAP_1" "$MAP_2"; then
  printf 'The two clean builds of %s produced different module maps\n' "$COMMIT" >&2
  exit 1
fi

# The Supervisor stores the canonical form, which adds the commit and sorts modules by name. Equal
# build output therefore means equal canonical maps, because canonicalization is a function of the
# build output and the commit the Supervisor asked for.
printf 'Two clean builds of %s produced identical module maps\n' "$COMMIT"
