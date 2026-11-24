# Build the workspace on Cloudflare Computer

> **Review:** Human-approved

cf-stumble builds its workspace on Cloudflare Computer (`@cloudflare/computer`) instead of writing its own workspace and container code. Computer gives the Workspace Host a durable file store in the Durable Object's SQLite, a container whose disk `computerd` keeps in step with that store, and the isolate shell, a Worker-shell backend that runs text operations in a Dynamic Worker without waking the container.

The Workspace Host uses Computer's `ContainerBackend`, so the Host's own Durable Object schedules the container (`schedulingPolicy: "durable_object"`) and the Host picks the instance size when it starts it. The platform-scheduled `LegacyContainerBackend` is deprecated, and container snapshots (ADR-0053) need Durable Object scheduling.

The isolate shell handles text operations. The container runs Git (ADR-0052), Node, pnpm, TypeScript compilation, tests and project commands.

**Why Computer.** Writing this ourselves would mean a durable file store, a sync between that store and a container's disk, the container's lifecycle and a shell that runs without a container. Computer already provides all four, and Cloudflare maintains them. The cost is that Computer is preview software: cf-stumble patches `computerd` (ADR-0042), stops the idle container itself (ADR-0043), and has to retest the whole application workflow before it adopts a new release.

**Versions.** `package.json` pins the npm package and `infra/workspace-image/computerd.Dockerfile` pins the source commit that `computerd` is built from. Upgrade the two together. `docs/agents/design/computer-integration.md` lists the current pair and the upstream image that an unpatched build must match.
