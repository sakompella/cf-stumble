# Computer integration

cf-stumble uses Cloudflare Computer source commit `12336475c9fd03f5280a4537a707797fc0131fbd` with image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`. ADR-0026 records the decision.

## Pinned pair

Both pins must change and be retested together. The source contains unreleased `@cloudflare/computer` and `@cloudflare/computerd` 0.3.0, while npm `latest` remains 0.2.1; changing only one pin could combine incompatible versions.

## Verified capabilities

Worker-shell handles text operations and host-forwarded Git. The container handles Node, pnpm, TypeScript compilation, tests, and project commands.

The paired source and image ran on a paid Cloudflare account on 2026-08-29. Container commands worked after cold starts of about 2.6–2.9 seconds. Files persisted across requests and stayed isolated by workspace identity. The stock example provided Node 22.23.2, pnpm 11.24.0, Git, and FUSE. `pnpm add is-odd@3.0.1` installed and ran through network package access.

Computer issue [#114](https://github.com/cloudflare/computer/issues/114) reports a deployed WebSocket failure in 0.2.1. The exact 0.2.1 reproduction was not deployed, so the issue is neither disproved nor known to be fixed. Repeated warm and cold requests using the pinned 0.3.0 pair did not show the failure.

## Workspace layout remains open

The deployed test proves that Computer can provide durable, isolated files. It does not decide how cf-stumble should arrange them.

Possible layouts include one workspace per project, a separate harness project, a shared workspace with isolated roots, or a temporary combined view when the main harness needs both project and harness source. The design should grant the model access to the projects needed for the current work without requiring every repository to share one filesystem.

Sessions and accumulated context must survive useful generation changes, but they do not have to live beside project files. The supervisor should not own or interpret project files or accumulated context.

## Harness execution remains open

The harness source is TypeScript, while Dynamic Workers require Worker-executable modules. The project still needs to choose whether it emits one bundle or a module map and where those outputs are stored. Computer supplies the environment in which compilation and tests can run; it does not decide the artifact format.

Worker Loader names are cached. A production design must distinguish different executable contents so a changed harness does not silently reuse old code.

## Generation requests

A harness commit becomes a generation when the Supervisor gives that specific commit a generation label; a commit alone does not activate it. The user or mutable main harness may submit a harness revision as a generation candidate and may request activation or rollback of a specific existing generation. The immutable supervisor validates and performs or rejects those requests. The exact command, transport, and authentication mechanism remain open.

## Deployment risk

Dynamic Workers and Durable Object facets are beta, and Computer is preview software. Paid-account tests must exercise the exact Worker Loader, facet, Computer, and workspace-capability path before the project treats the integration as deployable.
