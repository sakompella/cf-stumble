FROM docker.io/library/node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS computerd-source

ARG DEBIAN_SNAPSHOT=20260610T000000Z
ARG COMPUTER_COMMIT=12336475c9fd03f5280a4537a707797fc0131fbd
ARG NODE_VERSION=v22.22.3
ARG NODE_LINUX_X64_SHA256=2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f
ARG NODE_DARWIN_X64_SHA256=939beff36e3adf3f93c5a9078d559e53245b488d5d47c5faf9fa0f1d21ede54d

RUN sed -i \
      -e "s#deb.debian.org/debian-security#snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}#" \
      -e "s#deb.debian.org/debian#snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}#" \
      /etc/apt/sources.list.d/debian.sources \
 && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/10snapshot \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils \
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
 && curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
 && curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-x64.tar.xz" \
 && printf '%s  %s\n' \
      "$NODE_LINUX_X64_SHA256" "node-${NODE_VERSION}-linux-x64.tar.xz" \
      "$NODE_DARWIN_X64_SHA256" "node-${NODE_VERSION}-darwin-x64.tar.xz" \
    | sha256sum -c - \
 && tar -xJf "node-${NODE_VERSION}-linux-x64.tar.xz" \
 && tar -xJf "node-${NODE_VERSION}-darwin-x64.tar.xz"

FROM computerd-source AS computerd-upstream
ARG UPSTREAM_COMPUTERD_SHA256=5d1a601f337004d1a9b43e243a65b7168832c900738b6d66df120ea77b6dc24c
RUN npm run build -w @cloudflare/dofs -w @cloudflare/computer-rpc -w @cloudflare/computerd \
 && npm run build:bin -w @cloudflare/computerd \
 && printf '%s  %s\n' "$UPSTREAM_COMPUTERD_SHA256" artifacts/computerd/computerd-linux-x64 \
    | sha256sum -c -

FROM computerd-source AS computerd
COPY containers/computerd-walk.patch /tmp/computerd-walk.patch
RUN git apply --check /tmp/computerd-walk.patch \
 && git apply /tmp/computerd-walk.patch
COPY containers/computerd-exec.patch /tmp/computerd-exec.patch
RUN git apply --check /tmp/computerd-exec.patch \
 && git apply /tmp/computerd-exec.patch
RUN npm run build -w @cloudflare/dofs -w @cloudflare/computer-rpc -w @cloudflare/computerd \
 && npm run typecheck -w @cloudflare/computerd \
 && (cd packages/computerd && npx vitest run src/shim src/exec/runner.test.ts) \
 && npm run build:bin -w @cloudflare/computerd \
 && install -D -m 0755 artifacts/computerd/computerd-linux-x64 /usr/local/bin/computerd

FROM docker.io/library/debian:stable-slim@sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5

ARG DEBIAN_SNAPSHOT=20261005T000000Z
ARG NODEJS_VERSION=22.23.3-1nodesource1
ARG GH_VERSION=2.102.0
ARG GH_LINUX_AMD64_DEB_SHA256=7e54a307f90afdc59796c325ec0c49fb09e6c18537727207a8ac7513584ea5b0

RUN sed -i \
      -e "s#deb.debian.org/debian-security#snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}#" \
      -e "s#deb.debian.org/debian#snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}#" \
      /etc/apt/sources.list.d/debian.sources \
 && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/10snapshot \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git tar \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
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

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=shim
ENV COMPUTERD_WALK_IGNORE=node_modules
ENV COMPUTERD_POLL_MS=5000
ENV COMPUTER_VAR_GH_CONFIG_DIR=/workspace/.config/gh
ENV COMPUTER_VAR_GIT_CONFIG_GLOBAL=/workspace/.gitconfig
EXPOSE 8080

ENV PNPM_HOME=/usr/local/pnpm
ENV PATH=/usr/local/pnpm:/usr/local/pnpm/bin:$PATH
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /seed/
COPY vendor/cloudflare-computer-0.3.0.tgz /seed/vendor/
RUN cd /seed \
 && corepack install \
 && corepack pnpm fetch \
 && rm -rf /seed

RUN mkdir -p /root/.local/share/pnpm \
 && ln -s /usr/local/pnpm/store /root/.local/share/pnpm/store

ENTRYPOINT ["/usr/local/bin/computerd"]
