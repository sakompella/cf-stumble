# Use the verified Computer source and image pair

Use Cloudflare Computer source commit `12336475c9fd03f5280a4537a707797fc0131fbd` with image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`. Upgrade and retest the pair together because its internal `@cloudflare/computer` and `@cloudflare/computerd` packages are unreleased `0.3.0`, while npm `latest` is still `0.2.1`.

Worker-shell provides text operations and host-forwarded Git. The container provides Node, pnpm, TypeScript compilation, tests, and project commands.

The verified pair ran on a paid account on 2026-08-29. Container execution, persistent and isolated files, Node 22.23.2, pnpm 11.24.0, Git, FUSE, and network package installation all worked. Computer issue [#114](https://github.com/cloudflare/computer/issues/114) for `0.2.1` was neither reproduced nor disproved; repeated warm and cold requests with this `0.3.0` pair did not show it.

This decision selects the Computer implementation and pins. It does not decide how many workspaces cf-stumble uses, which repositories share a filesystem, or how TypeScript harness source becomes executable Worker modules.
