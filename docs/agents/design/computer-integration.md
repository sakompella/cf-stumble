# Computer integration

cf-stumble uses Cloudflare Computer source commit `12336475c9fd03f5280a4537a707797fc0131fbd` with image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`. ADR-0026 records the decision. The workspace image builds `computerd` from that commit with `containers/computerd-walk.patch` and `containers/computerd-exec.patch` applied, and checks that an unpatched build reproduces the image's binary. ADR-0042 records why the walk is patched. The exec patch waits for the child's `close` event before recording exit, so paused stdout and stderr drain before the command log closes. A normal exit has a bounded drain grace for inherited pipes, and an explicit kill closes the pipes at once.

Both pins change and are retested together. The source contains unreleased `@cloudflare/computer` and `@cloudflare/computerd` 0.3.0, while npm `latest` is 0.2.1. Before adopting a newer Computer release, prefer it only if the full application workflow passes against it. Computer issue [#114](https://github.com/cloudflare/computer/issues/114) reports a deployed WebSocket failure in 0.2.1; repeated requests on the pinned pair did not show it.

Worker-shell handles text operations and host-forwarded Git. The container handles Node, pnpm, TypeScript compilation, tests, and project commands.

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

A workspace reset would delete files under a running command, so the Supervisor refuses it with HTTP 409 `run-active` while a run is active, and a project disconnect the same way. A run is active from the wake that starts it until the wake that settles it, or until the Supervisor aborts it at its deadline. A fresh thread is allowed during a run: it aborts the project's current conversation and points the project at a new one. The Host also refuses a reset with HTTP 409 `workspace-busy` while it runs a build, provision, removal, managed-instructions write, or credential install.

From the moment a reset reaches the Supervisor until the Host answers, the Supervisor refuses a new message, a connect or disconnect, a project capability, and a second reset with `workspace-busy`. The Host applies the same exclusion for the same span: its operations refuse without running (a file change answers `workspace-busy`, a credential install `workspace-unavailable`), a project capability request throws, and a second reset answers `workspace-busy`. Both exclusions live in memory, one per object instance.

### Turn capability

A project's conversation runs in that project's directory. The project capability addresses the whole workspace, so the agent can read a sibling repository or the managed instructions, and the path guard is the workspace root, read from `WORKSPACE_ROOT` in `src/workspace-layout.ts` by both the guard and the path translation.

A run asks the Supervisor for a capability through its host's `workspace`, naming its conversation, and the capability lasts only as long as the run. The Supervisor asks the Host for it with the run's remaining time before its deadline, so the Host ends it at the deadline, and the Supervisor ends it again when the run settles. After that, `lstat`, `readFile`, `writeFile`, `listFiles`, and `startExec` answer `turn-ended`, also through a duplicate the generation kept, so a generation that ignores the end of its run cannot keep editing the workspace while a later run works. A refused call does not count as workspace activity, so late calls cannot keep the idle container running. `kill` and `endTurn` still answer. A container replacement refuses only the next command of a live run, with `container-restarted`, and file calls go on because the files are durable (`src/workspace/project/target.ts`).

The generation's `ExecutionEnv` (`src/facet/generation-1/execution-env.ts`) calls only this capability. It implements only the members that Pi Durable 1.4.0 calls outside its JSONL storage and its own tests. The other twelve (`readBinaryFile`, `appendFile`, `openTextLineReader`, `readTextLines`, `truncateFile`, `flushFile`, `renameFile`, `listDir`, `openDirReader`, `watch`, `createDir` and `remove`) answer a `not_supported` `FileError`, and the optional `listFiles` is left out. The capability has no mkdir and no open file handle, so `createTempDir` runs `mkdir` as a container command, and a binary reader reads the whole file into memory when it opens, which limits it to `MAX_FILE_BYTES`.

When you bump Pi Durable, search the new version for calls to those twelve members before you deploy, and implement any member it now calls:

```sh
cd node_modules/@earendil-works/pi-durable/dist && rg -n -g '*.js' -g '!storage/jsonl' -g '!testing' \
  '\.(readBinaryFile|appendFile|openTextLineReader|readTextLines|truncateFile|flushFile|renameFile|listDir|openDirReader|watch|createDir|remove)\('
```

In 1.4.0 it finds only Pi's own Node environment calling itself (`env/node.js`) and two unrelated `watch` methods in `harness/harness.js`.

## Harness execution

The harness source is TypeScript, while Dynamic Workers need Worker-executable modules. Computer builds a canonical module map for a labeled harness commit. The Supervisor validates it and stores it in its own SQLite under that commit, so nothing rebuilds to serve or roll back. ADR-0028 defines the artifact. The Supervisor uses the commit ID as the Worker Loader name, because Loader names are cached and a changed commit must not reuse old code.

### Build isolation

A build extracts its commit into `/tmp/cf-stumble-builds/<commit>` and clears that directory first. The path is container-local, outside `/workspace`, and holds no checkout, so clearing it destroys nothing. The harness directory is the owner's editable clone: a build reconciles and fetches into it, and refuses rather than deletes a populated directory that is not that repository. `HarnessArtifacts` (`src/supervisor/artifacts/index.ts`) admits one build per commit at a time, and a second request for a commit already building joins that build, because two builds of one commit would clear each other's directory.

### Build phases

The Supervisor's build runs `HARNESS_BUILD_CONFIGURATION.buildPhases` (`src/harness-build.ts`) in a directory `git archive` just wrote, which has tracked files only: an install from `pnpm-lock.yaml`, then a build of the module map. Each phase is its own Durable Object RPC with its own exit code, output tail, and `WORKSPACE_COMMAND_TIMEOUT_MS` timeout, because one long command died three times with no sign of which phase had been running. `pnpm run build:artifact` runs the same phases locally, and `test/supervisor/artifacts/build-command.test.ts` checks that they match.

A fresh build container needs pnpm, which downloads the version `package.json` pins on first run; Node 22; `registry.npmjs.org`; and `git`, `tar`, and outbound HTTPS to `github.com` for the clone and fetch. A developer machine hides most of these.

Run `pnpm probe:clean-build` before a release and before any paid build probe. It builds a commit twice with an isolated `HOME` and compares the module maps byte for byte. It is a pre-check and never starts a container; the release proof is two clean Computer builds of one labeled commit.

## Paid probes

Probes that run on the disposable paid Cloudflare account are approved. A local container run proves tool availability and build behavior, not deployed-platform behavior, and a report must not claim otherwise. A probe that cannot run states the blocker instead of reporting a simulated result as real.

## Container lifetime

The container does not stop by itself while the Workspace Host exists. Computer's backend accepts the WebSocket that computerd opens back to the Host, and nothing closes it, so the open request keeps the Durable Object active. The Host therefore stops an idle container itself: after ten minutes with no Host RPC in flight, no `exec` in flight, and no turn lease open, an alarm closes the `Workspace` and destroys the container (ADR-0043). An idle stop loses what a platform restart loses: files the sync does not copy into the durable store, such as `node_modules`, `/tmp`, and paths outside `/workspace`. Every `exec` pulls its changes into the store before it settles. The container's idle CPU is the shim's disk walk, which polls every five seconds (ADR-0044).

## Artifacts (deferred)

Cloudflare Artifacts is a Git server per repository. The owner decided on 2026-10-02 to skip it for now. It does not fit the current stores: the workspace is a live POSIX working tree that a container needs, a container cannot mount the FUSE filesystem Artifacts' mount tool uses (ADR-0042), and module maps must load with no network call. One gap would fit it: cf-stumble keeps no copy of uncommitted work outside the workspace, so a reset or a project disconnect destroys it. A pilot could checkpoint uncommitted work to Artifacts before those two operations. It would need a new paid product, a Git client inside the Worker (the binding cannot write files), and a remote simulator for tests. Revisit it only after the owner approves that cost.

## Deployment risk

Dynamic Workers and Durable Object facets are beta, and Computer is preview software. Paid-account tests must exercise the exact Worker Loader, facet, Computer, and workspace-capability path before the project treats the integration as deployable.
