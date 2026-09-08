# Runtime image for the container preflight probe.
#
# The reference `wrangler.jsonc` pins,
# `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`,
# is a single layer over `scratch` whose only content is the `computerd` binary. It has no libc,
# no shell and no toolchain, so nothing can run in it. The upstream container example therefore
# copies that binary into a Debian and Node userland, and this file repeats those instructions
# from Computer source commit `12336475c9fd03f5280a4537a707797fc0131fbd`
# (`examples/container/Dockerfile`) with one change: it names the pinned digest instead of the
# floating `:0.3.0` tag, so the preflight and the deployed pin cannot drift apart.
#
# `scripts/probe/container-preflight.sh` builds this image and runs the tool inventory and the two
# clean builds inside it. Nothing deploys it.

FROM ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f AS computerd

FROM docker.io/library/debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# computerd's defaults: HTTP and WebSocket on :8080, FUSE mount on MOUNT_POINT. FUSE_MOUNT=auto
# selects real FUSE where /dev/fuse exists and a userspace shim where it does not.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
