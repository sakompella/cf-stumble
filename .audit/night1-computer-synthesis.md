# Night 1 Computer vendoring synthesis

## Decision

Vendor the canonical package produced by `npm pack --workspace @cloudflare/computer`. Keep its package name `@cloudflare/computer` because its worker-shell output self-imports `@cloudflare/computer/shell/*`. Do not create a local facade.

## Evidence

A clean detached worktree at Computer commit `12336475c9fd03f5280a4537a707797fc0131fbd` passed `npm ci` and `npm run build --workspace @cloudflare/computer`. The build produced 78 files and 10,732 KiB. `npm pack` produced a 2,405,549-byte tarball with 10,820,145 unpacked bytes.

A Wrangler dry run imported `Workspace`, `CloudflareContainerBackend`, and `WorkerShellBackend` from that output. It produced a 3,370.66 KiB upload, 772.43 KiB compressed, with no unresolved imports.

Opus scored the full package above the narrow facade on faithfulness, maintenance, drift risk, Worker proof, and later worker-shell or Git use. The facade won only on checked-in bytes. The smaller option was rejected because it dropped ADR-0026 capabilities and introduced a hand-maintained declaration boundary after that approach already failed during Pi vendoring.

## Grafts

- Generate a local conformance file that imports only the subpaths cf-stumble uses. It checks the vendored declarations without changing the shipped package.
- Make the Wrangler dry run part of the checker. Computer intentionally uses `node:` imports with `nodejs_compat`, so a static ban would reject valid output.

## Rejections

- Reject a renamed package. Worker-shell self-imports the upstream package name.
- Reject a narrow facade. It adds a second API and declaration graph to maintain.
- Reject broad shims or polyfills. The canonical package already bundles unpublished Cloudflare internals.
- Reject clone-at-install. Normal install and verification use committed package output.

## Stop conditions

- Two clean builds or packs of the same source commit differ.
- Runtime JavaScript imports `@cloudflare/dofs` or `@cloudflare/computer-rpc`.
- Wrangler reports an unresolved import for a required subpath.
- The package cannot remain named `@cloudflare/computer` in the workspace.

## Verification contract

The worker must provide a generator and offline checker, a checksum tamper proof, the conformance compile, the Wrangler dry run, and `pnpm verify`. The worker reports the exact commands and commits only a green unit.
