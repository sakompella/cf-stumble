# Use the verified Computer source and image pair

> **Review:** Human-approved

Use Cloudflare Computer release `0.11.3`: the `@cloudflare/computer` package from npm and source commit `9d11fa7b7f77cb8130d3f53f285ba8e0f8ea258b` with image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:2978fc5b5ad3b2bc8429ef83e2b56079f938003ca94c3c89612f78d509d027ff`. Upgrade and retest the three together. The first pin was source commit `12336475c9fd03f5280a4537a707797fc0131fbd`, whose unreleased `0.3.0` package cf-stumble vendored as a tarball; 0.8.0 was a published release, so the lockfile integrity hash replaced the vendored copy.

The workspace image builds `computerd` from that commit with one patch instead of shipping the image's binary; ADR-0042 records why. The image's binary remains the reference an unpatched build of the commit must reproduce.

The Workspace Host uses 0.8.0's `ContainerBackend`, so the container is scheduled by its Durable Object (`schedulingPolicy: "durable-object"`) and the Host picks the instance size when it starts it. The platform-scheduled `LegacyContainerBackend` is deprecated.

Worker-shell provides text operations. The container provides Git (ADR-0052), Node, pnpm, TypeScript compilation, tests, and project commands.

The first pair ran on a paid account on 2026-08-29. Container execution, persistent and isolated files, Node 22.23.2, pnpm 11.24.0, Git, FUSE, and network package installation all worked. Computer issue [#114](https://github.com/cloudflare/computer/issues/114) for `0.2.1` was neither reproduced nor disproved; repeated warm and cold requests with this `0.3.0` pair did not show it.

This decision selects the Computer implementation and pins. It does not decide how many workspaces cf-stumble uses, which repositories share a filesystem, or how TypeScript harness source becomes executable Worker modules.
