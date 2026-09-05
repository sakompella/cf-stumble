# Computer integration

cf-stumble uses Cloudflare Computer source commit `12336475c9fd03f5280a4537a707797fc0131fbd` with image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`. ADR-0026 records the decision.

## Pinned pair

Both pins must change and be retested together. The source contains unreleased `@cloudflare/computer` and `@cloudflare/computerd` 0.3.0, while npm `latest` remains 0.2.1; changing only one pin could combine incompatible versions.

## Verified capabilities

Worker-shell handles text operations and host-forwarded Git. The container handles Node, pnpm, TypeScript compilation, tests, and project commands.

The paired source and image ran on a paid Cloudflare account on 2026-08-29. Container commands worked after cold starts of about 2.6–2.9 seconds. Files persisted across requests and stayed isolated by workspace identity. The stock example provided Node 22.23.2, pnpm 11.24.0, Git, and FUSE. `pnpm add is-odd@3.0.1` installed and ran through network package access.

Computer issue [#114](https://github.com/cloudflare/computer/issues/114) reports a deployed WebSocket failure in 0.2.1. The exact 0.2.1 reproduction was not deployed, so the issue is neither disproved nor known to be fixed. Repeated warm and cold requests using the pinned 0.3.0 pair did not show the failure.

## Upgrade follow-up

Before version 0 relies on the pinned pair, check whether Cloudflare has published a supported
Computer release that provides the required Worker-shell, container, and Durable Object behavior.
Prefer that release if the full application workflow passes against it. Until then, retain the
source and image pair that the paid-account test exercised; do not update one without the other.

## Workspace layout

Version 0 uses one durable Computer workspace for the owner's harness repository and connected
GitHub project repositories. Each repository has its own directory and Git history. The page selects
a project directory in which the main facet starts work, but the shared filesystem is not a security
boundary between the owner's repositories.

Each project also has one current Pi thread stored outside the workspace and outside generation
state. Starting a fresh thread replaces conversation and compacted context without changing project
files. Both the project thread and shared workspace survive main-harness generation changes.

The workspace behaves like an ordinary development machine. It has unrestricted outbound internet
access, `git`, `gh`, and repository toolchains. GitHub credentials live in local configuration
outside the repositories.

The current implementation still derives a separate Computer workspace name for each project and a
separate name for harness builds. It must be simplified to use the shared workspace before version 0
is complete.

## Harness execution

The harness source is TypeScript, while Dynamic Workers require Worker-executable modules. Computer
builds a canonical module map for a labeled harness commit. The Supervisor validates it and caches
the rebuildable output in R2 under that commit. Computer supplies the environment in which
compilation and tests run; ADR-0028 and ADR-0034 define the artifact and cache.

Worker Loader names are cached. The Supervisor uses the labeled harness commit ID as the Loader name, so a changed harness commit does not silently reuse old code.

## Generation requests

A harness commit becomes a generation when the Supervisor gives that specific commit a generation label; a commit alone does not activate it. The user or mutable main harness may submit a harness revision as a generation candidate and may request activation or rollback of a specific existing generation. The immutable supervisor validates and performs or rejects those requests directly, without a request ID or request journal. The exact command, transport, and authentication mechanism remain open.

## Deployment risk

Dynamic Workers and Durable Object facets are beta, and Computer is preview software. Paid-account tests must exercise the exact Worker Loader, facet, Computer, and workspace-capability path before the project treats the integration as deployable.
