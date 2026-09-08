#!/usr/bin/env bash
#
# Container preflight for the pinned Computer container image.
#
# `wrangler.jsonc` binds the WorkspaceHost container to one image reference. That image runs only
# on x86-64, so no earlier session on an arm64 machine could start it. This script starts it on an
# x86-64 Linux machine with Podman and answers three questions that goal criteria 3 and 7 depend
# on, without spending anything: what the pinned reference actually contains, which tools a
# workspace container offers, and whether two clean builds of one commit inside that container
# produce the same module map.
#
# What it does, in order:
#   1. Reads the container image reference out of `wrangler.jsonc`, so the probe always inspects
#      the pin the Worker deploys rather than a copy of it that can drift.
#   2. Pulls that reference and prints the resolved digest.
#   3. Lists the files the pinned image contains and tries to run it. The upstream image is a
#      single layer over `scratch` holding only the `computerd` binary, so this step records
#      whether the deployed reference can host a toolchain at all.
#   4. Builds the runtime image from `scripts/probe/container-preflight.Dockerfile`, which copies
#      `computerd` out of the same pinned digest into the Debian and Node userland that the
#      upstream container example uses.
#   5. Reports the version of `node`, `pnpm`, `git`, `gh` and `rg` inside that runtime image. A
#      missing tool is printed and does not stop the run, because which tools are absent is the
#      result this step exists to record.
#   6. Builds one commit twice inside the runtime image with the container's own PATH, HOME and
#      pnpm store, and compares the two module maps byte for byte.
#
# Usage:
#   scripts/probe/container-preflight.sh [commit-ish]     # default: HEAD
#
# Environment:
#   CONTAINER_TOOL                 container CLI to use (default: podman)
#   EXPECTED_MODULE_MAP_SHA256     compare the container digests against this host digest too
#   CONTAINER_PREFLIGHT_KEEP=1     keep the temporary directory for inspection
#
# It makes no Cloudflare API call, creates no Computer workspace, deploys no Worker and spends
# nothing beyond public image and npm registry downloads. It is local container evidence only: it
# runs the container under Podman, not under Cloudflare Containers, so it cannot prove any
# deployed behaviour.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMITTISH="${1:-HEAD}"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify "${COMMITTISH}^{commit}")"
CONTAINER_TOOL="${CONTAINER_TOOL:-podman}"
DOCKERFILE="${REPO_ROOT}/scripts/probe/container-preflight.Dockerfile"

if ! command -v "$CONTAINER_TOOL" >/dev/null 2>&1; then
  printf 'Container tool not found: %s\n' "$CONTAINER_TOOL" >&2
  exit 1
fi

# The pin the Worker deploys. Read from the `containers` block so that a changed pin changes what
# this probe inspects.
IMAGE_REF="$(
  awk '/"containers":/{inside=1} inside && /"image":/{print; exit}' "${REPO_ROOT}/wrangler.jsonc" |
    sed -e 's/.*"image": *"//' -e 's/".*//'
)"
if [ -z "$IMAGE_REF" ]; then
  printf 'No container image reference found in %s\n' "${REPO_ROOT}/wrangler.jsonc" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-stumble-container-preflight.XXXXXXXX")"
cleanup() {
  if [ "${CONTAINER_PREFLIGHT_KEEP:-0}" = "1" ]; then
    printf 'Kept %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

printf 'Container preflight of %s\n' "$COMMIT"
printf 'Work directory: %s\n' "$WORK"
printf 'Container tool: %s (%s)\n' "$CONTAINER_TOOL" "$("$CONTAINER_TOOL" --version)"
printf 'Pinned image reference: %s\n' "$IMAGE_REF"

##############################################################################
# 1. The pinned image itself
##############################################################################

"$CONTAINER_TOOL" pull "$IMAGE_REF" >"${WORK}/pull.log" 2>&1 || {
  printf 'Pull failed. Log:\n' >&2
  cat "${WORK}/pull.log" >&2
  exit 1
}

printf 'Resolved digest: %s\n' \
  "$("$CONTAINER_TOOL" image inspect "$IMAGE_REF" --format '{{.Digest}}')"
printf 'Resolved architecture: %s/%s\n' \
  "$("$CONTAINER_TOOL" image inspect "$IMAGE_REF" --format '{{.Os}}')" \
  "$("$CONTAINER_TOOL" image inspect "$IMAGE_REF" --format '{{.Architecture}}')"
printf 'Entrypoint: %s\n' \
  "$("$CONTAINER_TOOL" image inspect "$IMAGE_REF" --format '{{json .Config.Entrypoint}}')"

# The image filesystem, read without running anything in it.
PINNED_CONTAINER="cf-stumble-preflight-pinned-$$"
"$CONTAINER_TOOL" create --name "$PINNED_CONTAINER" --entrypoint '' "$IMAGE_REF" true \
  >/dev/null 2>&1
"$CONTAINER_TOOL" export "$PINNED_CONTAINER" -o "${WORK}/pinned-image.tar"
"$CONTAINER_TOOL" rm "$PINNED_CONTAINER" >/dev/null
tar -tf "${WORK}/pinned-image.tar" | sort >"${WORK}/pinned-image-files.txt"

printf 'Pinned image entries: %s\n' "$(wc -l <"${WORK}/pinned-image-files.txt" | tr -d ' ')"
sed -e 's/^/  /' "${WORK}/pinned-image-files.txt"

if grep -qx 'bin/sh' "${WORK}/pinned-image-files.txt"; then
  printf 'The pinned image provides /bin/sh\n'
else
  printf 'The pinned image provides no /bin/sh, so it can run no shell command\n'
fi

# Running the pinned reference directly is what a deployed container would do.
printf 'Running the pinned image directly:\n'
"$CONTAINER_TOOL" run --rm "$IMAGE_REF" --version >"${WORK}/pinned-run.log" 2>&1 || true
sed -e 's/^/  /' "${WORK}/pinned-run.log"

##############################################################################
# 2. The runtime image built from the same pinned digest
##############################################################################

if ! grep -q "$IMAGE_REF" "$DOCKERFILE"; then
  printf '%s does not build from the pinned reference %s\n' "$DOCKERFILE" "$IMAGE_REF" >&2
  exit 1
fi

RUNTIME_TAG="cf-stumble-container-preflight:${COMMIT:0:12}"
printf 'Building runtime image %s from %s\n' "$RUNTIME_TAG" "$DOCKERFILE"
"$CONTAINER_TOOL" build -f "$DOCKERFILE" -t "$RUNTIME_TAG" "${REPO_ROOT}/scripts/probe" \
  >"${WORK}/build-image.log" 2>&1 || {
  printf 'Runtime image build failed. Last 40 log lines:\n' >&2
  tail -40 "${WORK}/build-image.log" >&2
  exit 1
}
printf 'Runtime image id: %s\n' \
  "$("$CONTAINER_TOOL" image inspect "$RUNTIME_TAG" --format '{{.Id}}')"

##############################################################################
# 3. Tool inventory inside the runtime image
##############################################################################

cat >"${WORK}/inventory.sh" <<'INVENTORY'
set -u
printf 'PATH inside the container: %s\n' "$PATH"
printf 'Kernel: %s\n' "$(uname -srm)"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  printf 'Distribution: %s\n' "$PRETTY_NAME"
fi
for tool in node pnpm npm corepack git gh rg tar; do
  path="$(command -v "$tool" 2>/dev/null || true)"
  if [ -z "$path" ]; then
    printf '%-8s ABSENT\n' "$tool"
  else
    printf '%-8s %-24s %s\n' "$tool" "$path" "$("$tool" --version 2>&1 | head -1)"
  fi
done
printf 'computerd: %s\n' "$(command -v computerd || printf 'ABSENT')"
printf 'FUSE device: %s\n' "$([ -e /dev/fuse ] && printf present || printf absent)"
INVENTORY

printf 'Tool inventory inside %s:\n' "$RUNTIME_TAG"
"$CONTAINER_TOOL" run --rm --entrypoint /bin/sh \
  -v "${WORK}:/probe:rw" \
  "$RUNTIME_TAG" /probe/inventory.sh 2>&1 | sed -e 's/^/  /'

##############################################################################
# 4. Two clean builds of one commit inside the runtime image
##############################################################################

git -C "$REPO_ROOT" archive --format=tar -o "${WORK}/source.tar" "$COMMIT"
printf 'Archive bytes: %s\n' "$(wc -c <"${WORK}/source.tar" | tr -d ' ')"

# The container's own toolchain runs the build. `env -i` drops every host variable and the PATH
# below is the container's, so nothing the host installed can take part.
cat >"${WORK}/clean-build.sh" <<'CLEANBUILD'
set -eu

run_build() {
  index="$1"
  directory="/probe/build-${index}"
  home="/probe/home-${index}"

  mkdir -p "$directory" "$home"
  tar -x -C "$directory" -f /probe/source.tar

  if [ -e "${directory}/node_modules" ] || [ -e "${directory}/vendor/pi-v0.84.4/dist" ]; then
    printf 'The extracted commit already contains build output; the probe would prove nothing\n' >&2
    return 1
  fi

  started="$(date +%s)"
  (
    cd "$directory"
    env -i \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      HOME="$home" \
      TMPDIR=/tmp \
      SHELL=/bin/sh \
      COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
      npm_config_userconfig="${home}/.npmrc" \
      npm_config_globalconfig="${home}/.npmrc.global" \
      pnpm run build:artifact
  ) >"/probe/build-${index}.log" 2>&1 || {
    printf 'Build %s failed inside the container. Last 40 log lines:\n' "$index" >&2
    tail -40 "/probe/build-${index}.log" >&2
    return 1
  }
  ended="$(date +%s)"

  map="${directory}/build/module-map.json"
  if [ ! -s "$map" ]; then
    printf 'Build %s produced no module map at %s\n' "$index" "$map" >&2
    return 1
  fi

  printf 'Build %s: %s seconds, module map %s bytes, build directory %s, cold store %s\n' \
    "$index" "$((ended - started))" "$(wc -c <"$map" | tr -d ' ')" \
    "$(du -sh "$directory" | cut -f1)" \
    "$(du -sh "$home" | cut -f1)"
}

if ! command -v pnpm >/dev/null 2>&1; then
  if ! command -v corepack >/dev/null 2>&1; then
    printf 'The container has neither pnpm nor corepack, so it cannot run the build command\n' >&2
    exit 1
  fi
  printf 'The container image ships no pnpm; enabling the bundled corepack shim\n'
  corepack enable pnpm
fi
printf 'pnpm used for the builds: %s (%s)\n' "$(command -v pnpm)" "$(pnpm --version 2>&1 | tail -1)"

run_build 1
run_build 2

for index in 1 2; do
  printf 'Module map sha256 (build %s): %s\n' \
    "$index" "$(sha256sum "/probe/build-${index}/build/module-map.json" | cut -d' ' -f1)"
done

if cmp -s /probe/build-1/build/module-map.json /probe/build-2/build/module-map.json; then
  printf 'The two clean container builds produced identical module maps\n'
else
  printf 'The two clean container builds produced different module maps\n' >&2
  exit 1
fi
CLEANBUILD

printf 'Two clean builds inside %s:\n' "$RUNTIME_TAG"
"$CONTAINER_TOOL" run --rm --entrypoint /bin/sh \
  -v "${WORK}:/probe:rw" \
  "$RUNTIME_TAG" /probe/clean-build.sh 2>&1 | tee "${WORK}/clean-build-container.log" |
  sed -e 's/^/  /'

CONTAINER_DIGEST="$(
  sed -ne 's/^Module map sha256 (build 1): //p' "${WORK}/clean-build-container.log"
)"

##############################################################################
# 5. Host comparison, when the caller supplies a host digest
##############################################################################

if [ -n "${EXPECTED_MODULE_MAP_SHA256:-}" ]; then
  if [ "$CONTAINER_DIGEST" = "$EXPECTED_MODULE_MAP_SHA256" ]; then
    printf 'The container module map matches the expected host digest %s\n' \
      "$EXPECTED_MODULE_MAP_SHA256"
  else
    printf 'The container module map %s differs from the expected host digest %s\n' \
      "$CONTAINER_DIGEST" "$EXPECTED_MODULE_MAP_SHA256"
    printf 'A host and container difference is a result to record, not a probe failure\n'
  fi
fi

printf 'Container preflight of %s finished\n' "$COMMIT"
printf 'This is local Podman evidence. It proves nothing about Cloudflare Containers, and it\n'
printf 'closes no part of goal criterion 7 or 9 that needs a deployed Computer workspace.\n'
