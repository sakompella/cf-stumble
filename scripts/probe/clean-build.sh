#!/usr/bin/env bash

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

run_build() {
  local index="$1"
  local directory="${WORK}/build-${index}"
  local home="${WORK}/home-${index}"

  mkdir -p "$directory" "$home"
  tar -x -C "$directory" -f "$ARCHIVE"

  if [ -e "${directory}/node_modules" ]; then
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

printf 'Two clean builds of %s produced identical module maps\n' "$COMMIT"
