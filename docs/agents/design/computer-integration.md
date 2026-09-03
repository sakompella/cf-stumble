# Computer integration

cf-stumble uses Cloudflare Computer source commit `12336475c9fd03f5280a4537a707797fc0131fbd` with image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`. ADR-0026 records the decision.

## Pinned pair

Both pins must change and be retested together. The source contains unreleased `@cloudflare/computer` and `@cloudflare/computerd` 0.3.0, while npm `latest` remains 0.2.1; changing only one pin could combine incompatible versions.

## Verified capabilities

Worker-shell handles text operations and host-forwarded Git. The container handles Node, pnpm, TypeScript compilation, tests, and project commands.

The paired source and image ran on a paid Cloudflare account on 2026-08-29. Container commands worked after cold starts of about 2.6–2.9 seconds. Files persisted across requests and stayed isolated by workspace identity. The stock example provided Node 22.23.2, pnpm 11.24.0, Git, and FUSE. `pnpm add is-odd@3.0.1` installed and ran through network package access.

Computer issue [#114](https://github.com/cloudflare/computer/issues/114) reports a deployed WebSocket failure in 0.2.1. The exact 0.2.1 reproduction was not deployed, so the issue is neither disproved nor known to be fixed. Repeated warm and cold requests using the pinned 0.3.0 pair did not show the failure.

## Workspace layout

Each connected GitHub project has one durable Computer workspace. The page selects a project, and
the main facet receives only that project's workspace capability. Harness builds run in a separate
workspace, so build commands cannot reach project files.

Each project also has one current Pi thread stored outside the workspace and outside generation
state. Starting a fresh thread replaces conversation and compacted context without changing project
files. Both the project thread and workspace survive main-harness generation changes.

Project workspaces behave like ordinary development machines. They have unrestricted outbound
internet access, `git`, `gh`, and repository toolchains. GitHub credentials live in the workspace's
local configuration outside the project repository.

## Harness execution remains open

The harness source is TypeScript, while Dynamic Workers require Worker-executable modules. The project still needs to choose whether it emits one bundle or a module map and where those outputs are stored. Computer supplies the environment in which compilation and tests can run; it does not decide the artifact format.

Worker Loader names are cached. The Supervisor uses the labeled harness commit ID as the Loader name, so a changed harness commit does not silently reuse old code.

## Generation requests

A harness commit becomes a generation when the Supervisor gives that specific commit a generation label; a commit alone does not activate it. The user or mutable main harness may submit a harness revision as a generation candidate and may request activation or rollback of a specific existing generation. The immutable supervisor validates and performs or rejects those requests. The exact command, transport, and authentication mechanism remain open.

## Deployment risk

Dynamic Workers and Durable Object facets are beta, and Computer is preview software. Paid-account tests must exercise the exact Worker Loader, facet, Computer, and workspace-capability path before the project treats the integration as deployable.
