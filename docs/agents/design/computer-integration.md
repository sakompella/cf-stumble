# Computer integration

cf-stumble uses Cloudflare Computer release 0.8.0: `@cloudflare/computer` from npm, source commit `9f0ade40196a4ef95ddde4f2b75e1555d9dfeeb1`, and image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:de6f3727a12c8adb2f8ece853105ccc461fef02f90e368fac4e0578eacc461aa`. ADR-0026 records the decision. The workspace image builds `computerd` from that commit with `infra/workspace-image/computerd-walk.patch` applied. ADR-0042 records why the walk is patched.

The Workspace Host runs the container through `ContainerBackend`, with the container scheduled by the Host's Durable Object. The instance size is `WORKSPACE_CONTAINER_INSTANCE` in `infra/worker-settings.ts`, and the image is the `app` Container that `infra/alchemy.run.ts` attaches to the `WorkspaceHost` Durable Object class. Upgrade the package, the commit and the image together, and adopt a newer release only if the full application workflow passes against it.

The workspace image is built once in CI and published to GitHub Container Registry as `ghcr.io/sakompella/cf-stumble-workspace:<hash>`. The deploy and every machine that runs the container pull it, and nothing builds it locally.

The Workspace Host has two exec backends. The container handles Node, pnpm, TypeScript compilation, tests, and project commands. The isolate backend runs just-bash in a Dynamic Worker with Git over the SQLite workspace, so it handles text operations and Git without waking the container; it has no Node, pnpm or `gh`, and its only network use is Git fetch, pull and push to GitHub over HTTPS with the token from the `gh` hosts file (`src/workspace/project/git-fs.ts`). It is the only writer of `.git`. In the container, `git` is a wrapper (`infra/workspace-image/git-readonly.sh`, installed as `/usr/local/bin/git`; real Git stays at `/usr/bin/git`) that runs read-only subcommands and `clone` into a new directory with `GIT_OPTIONAL_LOCKS=0`, and refuses every other form with exit 1 and a message that tells the agent to run the command on its own so the isolate takes it. cf-stumble's own container scripts that must still write set `CF_STUMBLE_CONTAINER_GIT_WRITE=1`: the `core.fileMode` setting after a large project's container clone, and `gh auth setup-git`. A `bash` call that names no backend runs in the isolate when every program in it is one the isolate has, and in the container otherwise; its optional `backend` parameter forces the container (`src/workspace/project/exec-selection.ts`). The shell's modules ship as the static asset `ASSETS` and are loaded into the Dynamic Worker.

## Workspace layout

One durable Computer workspace holds the owner's harness repository and the connected GitHub project repositories, each in its own directory with its own Git history. The page selects the project directory a turn starts in, but the shared filesystem is not a security boundary between the repositories.

Each project's conversations live in the serving facet's Pi Durable storage, outside the workspace and outside generation state (ADR-0048). Starting a fresh thread points the project at a new conversation without changing project files. The conversations and the workspace both survive generation changes.

The workspace name comes from the tenant and nothing else. The Worker reaches one Supervisor by a constant name, and the Supervisor derives its one workspace name from that, so harness builds and every project reach the same container.

`src/workspace-layout.ts` owns the layout:

| Path                               | Holds                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `/workspace`                       | The workspace root. Every addressed path lives beneath it.                          |
| `/workspace/AGENTS.md`             | The managed instructions, above every repository.                                   |
| `/workspace/harness`               | The owner's editable harness checkout.                                              |
| `/workspace/.config/gh`            | `gh` configuration, including the GitHub credential (`hosts.yml`).                  |
| `/workspace/.gitconfig`            | Git's global configuration, including the `gh` credential helper.                   |
| `/workspace/projects/<project id>` | One connected project's clone.                                                      |
| `/tmp/cf-stumble-builds/<commit>`  | Build scratch for one labeled commit, outside `/workspace`. It holds no repository. |

The workspace behaves like an ordinary development machine: unrestricted outbound internet, `git`, `gh`, and repository toolchains. GitHub credentials live in `gh` and Git configuration under `/workspace`, so they survive a container replacement.

cf-stumble owns `/workspace/AGENTS.md`. Whenever a run asks for a project capability, provisioning calls the Workspace Host's `ensureManagedInstructions`, which writes the current text over whatever file is there. An instruction change reaches the workspace at the first run after a deploy, and an edit to the file lasts only until the next run. The Host refuses the write when the workspace root or the file is a symbolic link, or the path is a directory. Provisioning never writes a repository's own `AGENTS.md`.

### Resets and fresh threads

A workspace reset would delete files under a running command, so the Supervisor refuses it with HTTP 409 `run-active` while a run is active, and a project disconnect the same way. A run is active from when the facet reports its conversation running until the facet reports it settled, or until its own deadline passes. The facet reports each running conversation with its run, the first input submission Pi placed for it, so a queued follow-up that starts in the same commit as the previous run ends is a new run: the Supervisor ends the previous run's workspace capability and gives the follow-up its own deadline. A fresh thread is allowed during a run: it aborts the project's current conversation and points the project at a new one. The Host also refuses a reset with HTTP 409 `workspace-busy` while it runs a build, provision, removal, managed-instructions write, or credential install.

From the moment a reset reaches the Supervisor until the Host answers, the Supervisor refuses a new message, a connect or disconnect, a project capability, and a second reset with `workspace-busy`. The Host applies the same exclusion for the same span: its operations refuse without running (a file change answers `workspace-busy`, a credential install `workspace-unavailable`), a project capability request throws, and a second reset answers `workspace-busy`. Both exclusions live in memory, one per object instance.

### Turn capability

A project's conversation runs in that project's directory. The project capability addresses the whole workspace, so the agent can read a sibling repository or the managed instructions, and the path guard is the workspace root, read from `WORKSPACE_ROOT` in `src/workspace-layout.ts` by both the guard and the path translation.

A run asks the Supervisor for a capability through its host's `workspace`, naming its conversation, and the capability lasts only as long as that run. The Supervisor refuses a conversation whose run it has no record of or whose deadline has passed. The Supervisor asks the Host for it with the run's remaining time before its deadline, so the Host ends it at the deadline, and the Supervisor ends it again when the run settles. After that, `lstat`, `readFile`, `writeFile`, and `startExec` answer `turn-ended`, also through a duplicate the generation kept, so a generation that ignores the end of its run cannot keep editing the workspace while a later run works. A refused call does not count as workspace activity, so late calls cannot keep the idle container running. `kill` and `endTurn` still answer. A container replacement refuses only the next command of a live run, with `container-restarted`, and file calls go on because the files are durable (`src/workspace/project/target.ts`).

The generation's `ExecutionEnv` (`src/facet/generation-1/execution-env.ts`) calls only this capability. It implements only the members that the installed tools (Pi Durable 1.5.0's coding tools) and the prompt call. Every other member answers a `not_supported` `FileError`, and the optional `listFiles` is left out. The capability has no open file handle, so a binary reader reads the whole file into memory when it opens, which limits it to `MAX_FILE_BYTES`.

When you bump Pi Durable, search the new version for calls to the members that file stubs out before you deploy, and implement any member it now calls:

```sh
cd node_modules/@earendil-works/pi-durable/dist && rg -n -g '*.js' -g '!storage/jsonl' -g '!testing' \
  '\.(readBinaryFile|appendFile|openTextLineReader|readTextLines|truncateFile|flushFile|renameFile|listDir|openDirReader|watch|createDir|remove)\('
```

In 1.5.0 it finds only Pi's own Node environment calling itself (`env/node.js`), a doc comment in `harness/transcript.js`, and two unrelated `watch` methods in `harness/harness.js` (the host's views and the task graph).

A generation must also speak the Supervisor's current facet-to-Supervisor protocol. `FACET_COMPATIBILITY` in `src/facet/runtime-contract.ts` is `pi-durable@<version>/host-<N>`, the facet reports it from `compatibility()`, and the startup check, activation and rollback compare it exactly. Bump `host-N` when the facet-to-Supervisor RPC contract changes: a host call the facet makes (`arm`, `running`, `workspace`) or a facet method the Supervisor calls. A Pi Durable bump changes the key by itself. An optional trailing argument, such as the `failed` map that `running` carries, leaves the key alone: an older facet omits it and an older Supervisor ignores it.

## Harness execution

The harness source is TypeScript, while Dynamic Workers need Worker-executable modules. Computer builds a canonical module map for a labeled harness commit. The Supervisor validates it and stores it in its own SQLite under that commit, so nothing rebuilds to serve or roll back. ADR-0028 defines the artifact. The Supervisor uses the commit ID as the Worker Loader name, because Loader names are cached and a changed commit must not reuse old code.

### Build isolation

A build extracts its commit into `/tmp/cf-stumble-builds/<commit>` and clears that directory first. The path is container-local, outside `/workspace`, and holds no checkout, so clearing it destroys nothing. The harness directory is the owner's editable clone. The build's provision step runs on the Workspace Host with the isolate Git client, not in the container (`src/workspace/harness-provision.ts`): it clones the harness at depth 50 through a staging directory when it is missing, refuses rather than deletes a populated directory that is not a repository, and refuses a checkout whose origin is another remote. It deepens the fetch (depth 500, 5,000, then 100,000) until the pinned commit is present, because isomorphic-git cannot fetch a bare commit ID, and otherwise fails with `harness commit <commit> is not in <remote>`. A checkout with no local tracked changes is fast-forwarded to its upstream; one with changes is left as it is, with a message. One provision runs at a time per Host (a semaphore in `ComputerWorkspaceOperations`). The later `checkout` step only reads the repository with `git archive` in the container. `HarnessArtifacts` (`src/supervisor/artifacts/index.ts`) admits one build per commit at a time, and a second request for a commit already building joins that build, because two builds of one commit would clear each other's directory.

### Build phases

The Supervisor's build runs `HARNESS_BUILD_CONFIGURATION.buildPhases` (`src/harness-build.ts`) in a directory `git archive` just wrote, which has tracked files only: a production install (`--prod`) from `pnpm-lock.yaml`, then a build of the module map. The build needs only the runtime packages and `esbuild`, which is a production dependency for that reason, and Node runs the build script with its own type stripping. Each phase is its own Durable Object RPC with its own exit code, output tail, and `WORKSPACE_COMMAND_TIMEOUT_MS` timeout, because one long command died three times with no sign of which phase had been running.

A fresh build container needs pnpm, which downloads the version `package.json` pins on first run; Node 22; `registry.npmjs.org`; and `git` and `tar` for the archive. The Host's isolate reaches `github.com` over HTTPS for the clone and fetch. A developer machine hides most of these.

The release proof is two clean Computer builds of one labeled commit.

## Paid probes

Probes that run on the disposable paid Cloudflare account are approved. A local container run proves tool availability and build behavior, not deployed-platform behavior, and a report must not claim otherwise. A probe that cannot run states the blocker instead of reporting a simulated result as real.

## Container lifetime

The container does not stop by itself while the Workspace Host exists. Computer's backend accepts the WebSocket that computerd opens back to the Host, and nothing closes it, so the open request keeps the Durable Object active. The Host therefore stops an idle container itself: after ten minutes with no Host RPC in flight, no `exec` in flight, and no turn lease open, an alarm closes the `Workspace` and destroys the container (ADR-0043). An idle stop loses what a platform restart loses: files the sync does not copy into the durable store, such as `node_modules`, `/tmp`, and paths outside `/workspace`. Every `exec` pulls its changes into the store before it settles. The container's idle CPU is the shim's disk walk, which polls every five seconds (ADR-0044).

## Artifacts (deferred)

Cloudflare Artifacts is a Git server per repository. The owner decided on 2026-10-02 to skip it for now. It does not fit the current stores: the workspace is a live POSIX working tree that a container needs, a container cannot mount the FUSE filesystem Artifacts' mount tool uses (ADR-0042), and module maps must load with no network call. One gap would fit it: cf-stumble keeps no copy of uncommitted work outside the workspace, so a reset or a project disconnect destroys it. A pilot could checkpoint uncommitted work to Artifacts before those two operations. It would need a new paid product, a Git client inside the Worker (the binding cannot write files), and a remote simulator for tests. Revisit it only after the owner approves that cost.

## Deployment risk

Dynamic Workers and Durable Object facets are beta, and Computer is preview software. Paid-account tests must exercise the exact Worker Loader, facet, Computer, and workspace-capability path before the project treats the integration as deployable.
