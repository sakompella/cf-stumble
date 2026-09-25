# The workspace container image.
#
# `computerd` is built here from Cloudflare Computer's public source, not copied from Cloudflare's
# prebuilt image, so that one checked-in patch can change how its userspace shim walks the disk.
#
# Why the patch. A Cloudflare container cannot mount FUSE, so computerd runs its userspace shim
# (`FUSE_MOUNT=shim` below). Upstream, the shim finds disk changes by walking all of `/workspace`
# every 250 ms and again before every `fetchChanges`, that is, before every workspace pull. The walk
# uses `stat`, which follows symlinks, and it has no ignore list. A project's `node_modules`, or a
# symlink to a large tree anywhere, then costs a walk of tens of thousands of files on every
# workspace operation, and a deployed workspace wedged for minutes after one `npm install`.
# cf-stumble's `ignore` on `fetchChanges` (`src/workspace/host.ts`) keeps those files out of the
# Durable Object, but it cannot stop the walk. `containers/computerd-walk.patch` makes the shim use
# `lstat` and sync a symlink as a symlink, never following it, and skip every path with a segment
# in `COMPUTERD_WALK_IGNORE` in both directions, with the same whole-segment matching as the sync
# protocol's `ignore`. It also adds shim tests, which the build runs.
#
# The build. It follows upstream's release workflow (`.github/workflows/next-computerd-image.yml`)
# at the pinned commit: `npm ci`, build the `dofs`, `rpc` and `computerd` workspaces, then
# `npm run build:bin`, which bundles computerd with esbuild into a Node 22.22.3 single executable
# application. Two differences, both without effect on the binary:
#   - `npm ci --ignore-scripts`. The only install scripts compile native addons the binary does not
#     use; `build:bin` embeds fuse-native's shipped prebuild.
#   - the Node binaries `build:bin` injects into are downloaded and checked against their pinned
#     SHA-256 here, so `build:bin` finds them cached instead of downloading them unchecked.
# The work directory is upstream's CI checkout path, because the executable records the absolute
# path of its bootstrap script. With it, the `computerd-upstream` stage, which builds the same
# commit without the patch, reproduces the published binary
# (`ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`)
# byte for byte and checks its SHA-256. The deployed image does not depend on that stage, and
# BuildKit skips it; build it with `--target computerd-upstream` to check a pin.
#
# Moving to a new upstream commit:
#   1. Set `COMPUTER_COMMIT` to the new full commit hash.
#   2. If the release changed Node, update `NODE_VERSION` and both `NODE_*_SHA256` values from
#      `https://nodejs.org/dist/v<version>/SHASUMS256.txt`, and the builder image to that version.
#   3. Set `UPSTREAM_COMPUTERD_SHA256` to the SHA-256 of `/usr/local/bin/computerd` in the
#      published image for that commit, then run
#      `docker build --platform linux/amd64 --target computerd-upstream -f containers/computerd.Dockerfile .`
#   4. Re-apply the patch: check out the new commit, `git apply --3way containers/computerd-walk.patch`,
#      resolve, and write the result back with `git diff > containers/computerd-walk.patch`. If
#      upstream has fixed the walk itself, delete the patch and its stage.
#
# Everything after the build stages repeats upstream's container example
# (`examples/container/Dockerfile`): the binary copied into a Debian and Node userland.
#
# `wrangler.jsonc` names this file rather than a registry reference, because Cloudflare containers
# pull only from the deploying account's managed registry or from a registry that account has
# configured, and a fresh account has neither. wrangler builds this file and pushes the result to
# the account's own registry, which is also what Workers Builds does for a deploy button user.
# The build context is the repository root, and `.dockerignore` sends only the files this build
# copies.

# The pinned source, its locked dependencies and the Node binaries the executable is built on.
FROM docker.io/library/node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS computerd-source

ARG COMPUTER_COMMIT=12336475c9fd03f5280a4537a707797fc0131fbd
ARG NODE_VERSION=v22.22.3
ARG NODE_LINUX_X64_SHA256=2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f
ARG NODE_DARWIN_X64_SHA256=939beff36e3adf3f93c5a9078d559e53245b488d5d47c5faf9fa0f1d21ede54d

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /home/runner/work/computer/computer

# Fetching by full hash is the verification: git checks every object against it.
RUN git init -q . \
 && git remote add origin https://github.com/cloudflare/computer.git \
 && git fetch -q --depth 1 origin "$COMPUTER_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$COMPUTER_COMMIT"

RUN npm ci --no-audit --no-fund --ignore-scripts

# `build:bin` builds a linux-x64 and a macos-x64 executable and reuses cached Node binaries.
RUN mkdir -p .devbox/node-binaries \
 && cd .devbox/node-binaries \
 && curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
 && curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-x64.tar.xz" \
 && printf '%s  %s\n' \
      "$NODE_LINUX_X64_SHA256" "node-${NODE_VERSION}-linux-x64.tar.xz" \
      "$NODE_DARWIN_X64_SHA256" "node-${NODE_VERSION}-darwin-x64.tar.xz" \
    | sha256sum -c - \
 && tar -xJf "node-${NODE_VERSION}-linux-x64.tar.xz" \
 && tar -xJf "node-${NODE_VERSION}-darwin-x64.tar.xz"

# The unpatched pinned commit, checked against the published binary. Not part of the image.
FROM computerd-source AS computerd-upstream
ARG UPSTREAM_COMPUTERD_SHA256=5d1a601f337004d1a9b43e243a65b7168832c900738b6d66df120ea77b6dc24c
RUN npm run build -w @cloudflare/dofs -w @cloudflare/computer-rpc -w @cloudflare/computerd \
 && npm run build:bin -w @cloudflare/computerd \
 && printf '%s  %s\n' "$UPSTREAM_COMPUTERD_SHA256" artifacts/computerd/computerd-linux-x64 \
    | sha256sum -c -

# The patched computerd the image ships. The shim tests run before the executable is built.
FROM computerd-source AS computerd
COPY containers/computerd-walk.patch /tmp/computerd-walk.patch
RUN git apply --check /tmp/computerd-walk.patch \
 && git apply /tmp/computerd-walk.patch
RUN npm run build -w @cloudflare/dofs -w @cloudflare/computer-rpc -w @cloudflare/computerd \
 && npm run typecheck -w @cloudflare/computerd \
 && (cd packages/computerd && npx vitest run src/shim) \
 && npm run build:bin -w @cloudflare/computerd \
 && install -D -m 0755 artifacts/computerd/computerd-linux-x64 /usr/local/bin/computerd

FROM docker.io/library/debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git tar \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs gh \
 && rm -rf /var/lib/apt/lists/*

# The workspace is a development machine: it clones repositories with `git`, authorizes with `gh`,
# and builds a harness commit with the pnpm version `package.json` pins. Corepack ships with Node
# and fetches that pinned version on first use, so the image carries corepack rather than a second
# global pnpm that could disagree with the lockfile.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# computerd's defaults: HTTP and WebSocket on :8080, FUSE mount on MOUNT_POINT. The mode is `shim`
# rather than `auto` because a Cloudflare container exposes `/dev/fuse` without granting the
# privileges a real FUSE mount needs, so `auto` selects the kernel backend and computerd exits 1.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=shim
# The patched shim never walks or syncs these path segments (see the header). Keep this equal to
# `WORKSPACE_SYNC_IGNORES` in `src/workspace-layout.ts`; `test/workspace/computerd-image.test.ts`
# checks it.
ENV COMPUTERD_WALK_IGNORE=node_modules
EXPOSE 8080

# Seed the pnpm content-addressable store from this repository's lockfile.
#
# A harness build runs `pnpm install --frozen-lockfile` inside this container, and a cold install of
# 186 packages took five to twenty minutes against the registry, long enough that the container was
# recycled part way through more than once. `pnpm fetch` needs only the lockfile, so the store is a
# layer of the image and the build's install reads it instead of the network. A lockfile the store
# does not cover still installs, just slowly, so this is a speed decision and not a correctness one.
ENV PNPM_HOME=/usr/local/pnpm
ENV PATH=/usr/local/pnpm:/usr/local/pnpm/bin:$PATH
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /seed/
COPY vendor/cloudflare-computer-0.3.0.tgz /seed/vendor/
RUN cd /seed \
 && corepack install \
 && corepack pnpm fetch \
 && rm -rf /seed

# Put the store where a build will actually look for it.
#
# A command Computer runs in this container inherits `PATH` and nothing else, so `PNPM_HOME` never
# reaches the build, and pnpm falls back to its default under `$HOME`. It found an empty store
# there, downloaded all 182 packages from the registry, and the native install script that follows
# was killed for memory (exit 137). Neither `/root/.npmrc` nor `~/.config/pnpm/rc` moves the store;
# only `PNPM_HOME` does, which is the one thing the build does not get. So the default location is
# the seeded one.
RUN mkdir -p /root/.local/share/pnpm \
 && ln -s /usr/local/pnpm/store /root/.local/share/pnpm/store

ENTRYPOINT ["/usr/local/bin/computerd"]
