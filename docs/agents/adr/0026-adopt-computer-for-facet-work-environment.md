# Use the verified Computer source and image pair

> **Review:** Human-approved

Use Cloudflare Computer release `0.10.0`: the `@cloudflare/computer` package from npm and source commit `bb0a5db4b7e8c8a79625d63e0e272602f909640e` with image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:6ec793fa80f109acf8b3cd4e295284cfed97f61c03030b780a612ec22c49b294`. Upgrade and retest the three together. The first pin was source commit `12336475c9fd03f5280a4537a707797fc0131fbd`, whose unreleased `0.3.0` package cf-stumble vendored as a tarball; 0.8.0 was a published release, so the lockfile integrity hash replaced the vendored copy.

The workspace image builds `computerd` from that commit with one patch instead of shipping the image's binary; ADR-0042 records why. The image's binary remains the reference an unpatched build of the commit must reproduce.

The Workspace Host uses 0.8.0's `ContainerBackend`, so the container is scheduled by its Durable Object (`schedulingPolicy: "durable-object"`) and the Host picks the instance size when it starts it. The platform-scheduled `LegacyContainerBackend` is deprecated.

Worker-shell provides text operations. The container provides Git (ADR-0052), Node, pnpm, TypeScript compilation, tests, and project commands.

The first pair ran on a paid account on 2026-08-29. Container execution, persistent and isolated files, Node 22.23.2, pnpm 11.24.0, Git, FUSE, and network package installation all worked. Computer issue [#114](https://github.com/cloudflare/computer/issues/114) for `0.2.1` was neither reproduced nor disproved; repeated warm and cold requests with this `0.3.0` pair did not show it.

This decision selects the Computer implementation and pins. It does not decide how many workspaces cf-stumble uses, which repositories share a filesystem, or how TypeScript harness source becomes executable Worker modules.
