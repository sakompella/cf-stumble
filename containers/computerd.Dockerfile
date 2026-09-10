# The workspace container image.
#
# The Cloudflare Computer image this pins,
# `ghcr.io/cloudflare/computer-computerd-linux-x64`, is a single layer over `scratch` whose only
# content is the dynamically linked `computerd` binary. It has no libc, no shell and no toolchain,
# so it cannot be deployed as a container image on its own: Cloudflare starts it and the container
# exits 1. The upstream container example copies that binary into a Debian and Node userland, and
# this file repeats those instructions from Computer source commit
# `12336475c9fd03f5280a4537a707797fc0131fbd` (`examples/container/Dockerfile`), naming the pinned
# digest instead of the floating `:0.3.0` tag.
#
# `wrangler.jsonc` names this file rather than a registry reference, because Cloudflare containers
# pull only from the deploying account's managed registry or from a registry that account has
# configured, and a fresh account has neither. wrangler builds this file and pushes the result to
# the account's own registry, which is also what Workers Builds does for a deploy button user.
#
# `scripts/probe/container-preflight.sh` builds this same file, so the probed image and the
# deployed image cannot drift apart.
FROM ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f AS computerd

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
