FROM docker.io/library/node:22.23.4-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f AS computerd-source

ARG DEBIAN_SNAPSHOT=20261103T000000Z
ARG COMPUTER_COMMIT=bb0a5db4b7e8c8a79625d63e0e272602f909640e
ARG COMPUTERD_NODE_VERSION=v22.23.4
ARG COMPUTERD_NODE_LINUX_X64_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce

RUN sed -i \
      -e "s#deb.debian.org/debian-security#snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}#" \
      -e "s#deb.debian.org/debian#snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}#" \
      /etc/apt/sources.list.d/debian.sources \
 && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/10snapshot \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git xz-utils g++ make python3 pkg-config libfuse3-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /home/runner/work/computer/computer

RUN git init -q . \
 && git remote add origin https://github.com/cloudflare/computer.git \
 && git fetch -q --depth 1 origin "$COMPUTER_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$COMPUTER_COMMIT"

RUN npm ci --no-audit --no-fund --ignore-scripts

RUN mkdir -p .devbox/node-binaries \
 && cd .devbox/node-binaries \
 && curl -fsSLO "https://nodejs.org/dist/${COMPUTERD_NODE_VERSION}/node-${COMPUTERD_NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${COMPUTERD_NODE_LINUX_X64_SHA256}  node-${COMPUTERD_NODE_VERSION}-linux-x64.tar.xz" \
    | sha256sum -c - \
 && tar -xJf "node-${COMPUTERD_NODE_VERSION}-linux-x64.tar.xz"

RUN mkdir /build \
 && tar -C packages/computerd/vendor/fuse-napi --exclude=./build --exclude=./node_modules -cf - . \
    | tar -C /build -xf - \
 && cd /build \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error \
 && npx --yes node-gyp@11 rebuild --nodedir=/usr/local --loglevel=error
ENV COMPUTERD_FUSE_ADDON=/build/build/Release/fuse.node

FROM computerd-source AS computerd
COPY computerd-walk.patch /tmp/computerd-walk.patch
RUN git apply --check /tmp/computerd-walk.patch \
 && git apply /tmp/computerd-walk.patch
RUN npm run build -w @cloudflare/dofs -w @cloudflare/computer-rpc -w @cloudflare/computerd \
 && npm run typecheck -w @cloudflare/computerd \
 && (cd packages/computerd && npx vitest run src/shim) \
 && npm run build:bin -w @cloudflare/computerd \
 && install -D -m 0755 artifacts/computerd/computerd-linux-x64 /usr/local/bin/computerd

FROM docker.io/library/debian:stable-slim@sha256:13e0a2e78aa0554ad5ff66e4e260c6dbcdff807eb1f39d43b9fb0288aae88b04

ARG DEBIAN_SNAPSHOT=20261103T000000Z
ARG NODEJS_VERSION=22.23.4-1nodesource1
ARG GH_VERSION=2.103.3
ARG GH_LINUX_AMD64_DEB_SHA256=e3bafef96328d1a67de3a968bdfe1cc2ffd58cf6aba8b5e201356897ed06bb3d
ARG NIX_VERSION=2.35.6
ARG NIX_LINUX_X64_SHA256=b12ab64a291e41846b9da37b7f56eafa7683deaa267bafb2ed43440ab2f45f13

RUN sed -i \
      -e "s#deb.debian.org/debian-security#snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}#" \
      -e "s#deb.debian.org/debian#snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}#" \
      /etc/apt/sources.list.d/debian.sources \
 && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/10snapshot \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl git tar xz-utils \
      build-essential pkg-config unzip python3-venv \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSLo /etc/apt/keyrings/nodesource.asc https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "nodejs=${NODEJS_VERSION}" \
 && curl -fsSLo /tmp/gh.deb \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.deb" \
 && echo "${GH_LINUX_AMD64_DEB_SHA256}  /tmp/gh.deb" | sha256sum -c - \
 && apt-get install -y --no-install-recommends /tmp/gh.deb \
 && rm -rf /tmp/gh.deb /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

RUN mkdir -m 0755 /nix /etc/nix \
 && printf '%s\n' 'build-users-group =' 'experimental-features = nix-command flakes' 'sandbox = false' \
      > /etc/nix/nix.conf \
 && curl -fsSLo /tmp/nix.tar.xz \
      "https://releases.nixos.org/nix/nix-${NIX_VERSION}/nix-${NIX_VERSION}-x86_64-linux.tar.xz" \
 && echo "${NIX_LINUX_X64_SHA256}  /tmp/nix.tar.xz" | sha256sum -c - \
 && tar -C /tmp -xJf /tmp/nix.tar.xz \
 && USER=root "/tmp/nix-${NIX_VERSION}-x86_64-linux/install" --no-daemon --no-channel-add --no-modify-profile \
 && rm -rf /tmp/nix.tar.xz "/tmp/nix-${NIX_VERSION}-x86_64-linux"
ENV PATH=/root/.nix-profile/bin:$PATH

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
RUN git config --system init.defaultBranch main \
 && git config --system user.name cf-stumble \
 && git config --system user.email cf-stumble@users.noreply.github.com

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=shim
ENV COMPUTERD_WALK_IGNORE=node_modules,.venv
ENV COMPUTERD_POLL_MS=5000
ENV COMPUTER_VAR_GH_CONFIG_DIR=/workspace/.config/gh
ENV COMPUTER_VAR_GIT_CONFIG_GLOBAL=/workspace/.gitconfig
ENV COMPUTER_VAR_CARGO_TARGET_DIR=/tmp/cargo-target
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
