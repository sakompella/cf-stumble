# Computer integration plan

Adopt `@cloudflare/computer@0.2.1` for the supervisor's durable working tree, filesystem, and ordinary git workflow. Delete the hand-written object codec and the in-memory production seam, but keep the registry, activation ledger, validation gate, preflight, and four-primitive policy in this repository. The package's stock `WorkspaceServiceProxy` is too broad for an untrusted facet, so the integration needs one small project-owned capability proxy around Computer rather than a direct `WorkspaceStub`.

There is one incompatibility in the brief that cannot be hidden: a facet with `env: {}` has no route to call four proxied methods. The plan keeps the facet's `LOADER` absent and keeps `globalOutbound: null`, but adds one `WORKSPACE` service binding containing only `read`, `write`, `edit`, and `run`. If `env: {}` is literal and immutable, stop at the isolation spike; the requested agent cannot both run in the facet and use a supervisor-owned workspace.

**What the source says**

The npm package at `/tmp/cloudflare-computer-0.2.1/package` is MIT-licensed, preview-only, and its `package.json` has `publishConfig.tag: "unreleased"`. Its `Workspace` constructs `@cloudflare/dofs`'s SQLite database and `WorkspaceFilesystem`; `Workspace.git` is opt-in through `createGitClient()` from `@cloudflare/computer/git`. The git client uses isomorphic-git over the workspace provider, and its public path is `writeFile` → `add` → `commit`, not `writeTree` or `writeCommit`.

The shipped `dist/index.js` shows that `WorkspaceStub` exposes `fs`, `runtime`, `git`, `assets`, and `artifacts`. `dist/backends/worker-shell/index.js` passes that whole stub through `WorkspaceServiceProxy.getWorkspace()`, then registers host-forwarded `git`, Assets, and Artifacts commands. The package therefore must never be the capability handed to facet code. The current `src/agent/loader.ts` correctly gives the facet `env: {}` and `globalOutbound: null`, but the current production runtime is still not loaded into a facet; `docs/agents/design/slices.md` calls that gap out explicitly.

GitHub `main` at commit `de87919a4fd37242e960e13b7b3ba802d1eef0a0` has source changes that are described by the open release PR [#112](https://github.com/cloudflare/computer/issues/112) as unreleased `0.3.0`: container bearer authentication, changed container launch arguments, `/api` replacing `/ws`, and filtered container environments. The fetched `main` `package.json` still says `0.2.1`, so the version claim in the prompt describes a pending release rather than the checked-in package metadata. The plan pins npm `0.2.1` first and treats `main` as a separate compatibility track.

**File disposition**

- Delete `src/git/binary.ts`, `src/git/codec.ts`, `src/git/commit.ts`, `src/git/hash.ts`, and `src/git/tree.ts`. Computer's git client writes and reads ordinary git objects through its VFS, so keeping a second codec would preserve the largest maintenance burden without preserving a needed invariant.
- Keep `src/git/types.ts`, reduced to the `Sha` boundary, `parseSha`, `Signature`, and `assertNever`. The registry and attestation still need a validated git oid, while the package returns ordinary strings. `GitObject`, `TreeEntry`, and `FILE_MODE` can disappear unless a narrow repository adapter needs one of them internally.
- Delete `test/git/codec.test.ts`, `test/git/commit.test.ts`, `test/git/hash.test.ts`, `test/git/oracle.test.ts`, and `test/support/memory-fs.ts`. Their purpose is to prove our codec and its isomorphic-git oracle; the replacement tests exercise Computer's real VFS-backed git path in workerd.
- Delete `src/storage/do-sqlite.ts`, `src/storage/memory.ts`, `src/storage/conformance.ts`, and `src/storage/types.ts` after the migration. They implement the old object map and pointer store. Delete `test/storage/memory.test.ts` and `test/storage-do/store.test.ts`; their conformance claims no longer describe the storage boundary. The supervisor's registry tables remain direct `ctx.storage.sql` tables, not Computer tables.
- Delete `src/tools/workspace.ts` and remove `InMemoryWorkspace` from `src/tools/index.ts`. Replace the `Workspace` interface in `src/tools/types.ts` with the four-method capability type below. Keep `src/tools/edit.ts` and the pure primitive result/error logic in `src/tools/primitives.ts`; they still enforce path safety, unique edit matches, text-only reads, timeouts, and typed failures.
- Keep `src/generation/registry.ts`, `src/generation/registry-types.ts`, and the generation-number rules. Replace `src/generation/build.ts`, `read.ts`, `lineage.ts`, and `genesis.ts` with a `GenerationRepository` over `Workspace.git`; it owns the manifest convention and rejects malformed or unsupported module trees because those are cf-stumble rules, not Computer features.
- Keep `src/pointer/activation.ts` and its in-memory conformance implementation, but move the durable implementation into the supervisor's SQL-backed registry. Move any remaining pointer interface out of `src/storage/types.ts` into `src/pointer/` or the supervisor boundary.
- Keep `src/validation/**`, including the gate, canaries, preflight, and result shapes. Change its executor input from the deleted `Workspace` to the narrow capability or a supervisor-owned facet invocation. Keep validation result rows in supervisor SQLite.
- Keep `src/supervisor/supervisor.ts` and `src/agent/loader.ts`, but wire a supervisor-owned `Workspace` and the capability proxy into them. `src/index.ts` should stop exporting deleted storage and codec types and should export only the surviving domain types.

**The state that remains ours**

The generation registry, activation ledger, and live pointer stay in the supervisor Durable Object's SQLite. Promotion must update the candidate's registry state, the validation result, the activation ledger row, and the live pointer inside one `ctx.storage.transactionSync()` callback. Computer also uses this SQLite database for its VFS tables, but no Computer API participates in that promotion transaction: its calls are asynchronous and the workspace is storage, not the authority for activation. Splitting these rows across a workspace service, Artifacts, or another DO would make promotion observable in a torn state and remove the safety property the design depends on.

The validation gate stays ours because Computer has no opinion about baseline ratchets, mandatory canaries, `INCONCLUSIVE`, attestation provenance, or the candidate-to-live comparison. The static preflight stays ours because it checks the candidate's ability to load and retain the required actions before the expensive gate. The four-primitive policy stays ours because Computer's ready-made tools deliberately expose a much wider filesystem and runtime surface.

**The working-tree and git model**

Use one Computer workspace rooted at `/workspace` as the supervisor-owned working tree. The `.git` directory is ordinary VFS data and is not the registry: generation rows point to commit oids, while the registry assigns monotonic generation numbers and records baseline, materialization state, artifact digest, and validation evidence. The live pointer still points to a generation number, never directly to a mutable branch.

`GenerationRepository` should write authored modules into the working tree, stage them, and commit them through the public API. The exact package calls are:

```ts
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";

const workspace = new Workspace({
  storage: ctx.storage as unknown as DurableObjectStorageLike,
  git: createGitClient(),
  defaultGitIdentity: {
    name: "cf-stumble supervisor",
    email: "supervisor@cf-stumble.invalid",
  },
});

await workspace.git.init({ dir: "/workspace", defaultBranch: "main" });
await workspace.fs.writeFile("/workspace/agent.js", agentSource);
await workspace.fs.writeFile("/workspace/prompt.md", prompt);
await workspace.fs.writeFile("/workspace/policy.md", policy);
await workspace.git.add({
  dir: "/workspace",
  paths: ["agent.js", "prompt.md", "policy.md"],
});
const { oid } = await workspace.git.commit({
  dir: "/workspace",
  message: "materialize candidate",
});
```

The package's `GitClient` returns `{ oid: string }`; `GenerationRepository` must parse that string at its boundary and return `Sha`. It should read an immutable generation with `git.show`, recursive `git.lsTree`, and `git.catFile`, rather than checking out a commit and trusting the mutable working tree. This preserves the current attestation binding to the bytes actually loaded. The adapter should keep one client per workspace so Computer's unbounded pack/index cache and lazy module imports are reused.

For reference, the real Computer runtime call is also straightforward:

```ts
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";

const workspace = new Workspace({
  storage: ctx.storage as unknown as DurableObjectStorageLike,
  git: createGitClient(),
  backends: [
    new WorkerShellBackend({
      loader: env.LOADER,
      workspace: { binding: "Supervisor", id: ctx.id.toString() },
      ctx,
      egress: { mode: "none" },
    }),
  ],
});

using execution = await workspace.runtime.exec("printf 'ok\\n'", {
  cwd: "/workspace",
  encoding: "utf8",
});
const result = await execution.result();
```

That is verified against 0.2.1's `WorkerShellBackend` and `WorkspaceRuntime` declarations, but it is **not** an admissible implementation of the facet's `run` method: it gives the shell the broad `WorkspaceStub` described above. Use it only for a trusted supervisor-only experiment. The untrusted path uses the same shell semantics behind the narrow proxy below and does not use the stock `WorkspaceServiceProxy` as its host capability.

**Exact Worker wiring**

The initial deployment has no `containers` stanza. That keeps `CloudflareContainerBackend`, `computerd`, container credentials, and the deployed-only WebSocket path out of the first safety proof.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-stumble",
  "main": "src/supervisor/worker.ts",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat", "experimental", "enable_ctx_exports"],
  "durable_objects": {
    "bindings": [{ "name": "SUPERVISOR", "class_name": "Supervisor" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Supervisor"] }],
  "worker_loaders": [{ "binding": "LOADER" }],
  "secrets": {
    "required": ["SUPERVISOR_SECRET"],
  },
}
```

`nodejs_compat` is required by Computer's VFS/git bundle. `experimental` is required by the Worker-shell backend and Loader path. `enable_ctx_exports` is required by the package's actual `ctx.exports.WorkspaceServiceProxy(...)` access; open issue [#105](https://github.com/cloudflare/computer/issues/105) documents that omission from the 0.2.1 setup instructions. `worker_loaders` is the binding used by `src/agent/loader.ts` and by the shell runner. Keep the existing SQLite migration and secret; Computer adds idempotent VFS tables at construction and does not need a second migration entry.

The required top-level exports belong in `src/supervisor/worker.ts`:

```ts
export { WorkspaceServiceProxy, WorkspaceProxy } from "@cloudflare/computer";
export { FacetWorkspaceProxy } from "./workspace-capability.js";
export { Supervisor } from "./supervisor.js";
```

`WorkspaceProxy` is unused while containers are absent, but exporting it now is required for the package's container loopback design. `WorkspaceServiceProxy` must also be exported because the package assumes the name exists, but the facet loader must not put an instance of it in the facet environment.

**The four-method capability**

The service binding given to the candidate facet has this shape and no nested object:

```ts
type FacetWorkspace = {
  read(path: string): Promise<ReadResult>;
  write(path: string, content: string): Promise<WriteResult>;
  edit(path: string, oldText: string, newText: string): Promise<EditResult>;
  run(command: string): Promise<RunResult>;
};
```

The results are the existing typed primitive results, with the internal `bash` call mapped to the wire method `run`. `read`, `write`, and `edit` accept the current relative workspace paths; the supervisor validates them and resolves them under `/workspace` before calling `workspace.fs`. `run` accepts only a command string, fixes its virtual cwd, supplies no caller-selected environment, applies the existing 30-second timeout, and returns bounded `exitCode`, `stdout`, and `stderr`. It does not return a runtime handle or stream. The four wire methods are not a fifth action: model-facing `PRIMITIVE_KINDS` remains the existing `read`, `write`, `edit`, `bash` set until the rename is deliberately made in one compatibility change.

Implement `FacetWorkspaceProxy` as a top-level `WorkerEntrypoint` with props containing the supervisor binding name, supervisor id, and candidate generation identity. Its four methods resolve the supervisor DO namespace internally and call four supervisor methods that delegate to the private Computer workspace. The facet sees only `env.WORKSPACE`; `ctx.props` and the namespace lookup stay inside the proxy. The loader callback is otherwise:

```ts
return {
  compatibilityDate: "2025-01-01",
  compatibilityFlags: ["nodejs_compat"],
  mainModule: "agent.js",
  modules: { "agent.js": { js: source } },
  env: {
    WORKSPACE: ctx.exports.FacetWorkspaceProxy({
      props: {
        binding: "SUPERVISOR",
        id: ctx.id.toString(),
        generation,
      },
    }),
  },
  globalOutbound: null,
};
```

The root adapter used by `run` must map the shell's virtual `/` to `/workspace`, reject `..` after normalization, reject symlink and hard-link creation, hide `.git` and any supervisor-reserved directory, and refuse paths outside that root. The ordinary primitive path validator remains in front of every direct file method. These restrictions are project-owned; Computer's `WorkspaceFilesystem` intentionally exposes an absolute filesystem, including `/`.

Never cross this capability boundary:

- the Computer `Workspace`, `WorkspaceStub`, `workspace.fs`, `workspace.runtime`, `workspace.git`, `provider()`, database, or raw `ctx.storage`;
- `WorkspaceServiceProxy`, `WorkspaceProxy`, a Durable Object namespace, `ctx`, `ctx.exports`, `LOADER`, service bindings, or a fetcher other than the four-method proxy;
- Assets, Artifacts, git remotes, git credentials, `containerEnv`, image-baked credentials, or any host secret;
- arbitrary cwd, environment maps, stdin, callbacks, runtime handles, streams, error causes, or supervisor route URLs;
- `.git`, registry rows, activation history, validation corpus, accumulated context, and generation-0 reset controls.

This closes the specific 0.2.1 leaks: a Workspace holder gets the filesystem root and host-forwarded git, Assets, and Artifacts; git network requests run host-side and bypass `globalOutbound: null`; and commands can read `containerEnv` or image-baked credentials. `globalOutbound: null` still blocks ambient facet `fetch()` and `connect()`, while the service binding is an explicit capability rather than network egress.

Extend the existing `test/facet/facet-spike.test.ts` assertions for storage separation, exact bindings, blocked `fetch`/`connect`, supervisor-route denial, and reset after load/init failure. The binding assertion must change from `envKeys: []` to the one deliberate `WORKSPACE` key under the resolution above, and must continue asserting that `LOADER` and `SUPERVISOR_SECRET` are absent. Add tests that a facet can perform one read/write/edit/run round trip, cannot read `.git` or a supervisor table, cannot traverse out of `/workspace`, cannot invoke a sixth method, and cannot turn a failed capability call into a supervisor route call. Add a test that `run` cannot use git, Assets, Artifacts, or arbitrary environment values. The current egress tests remain necessary because a deliberate capability binding does not weaken ambient network denial.

**What `run` actually means**

0.2.1's Worker shell is just-bash over a virtual filesystem. It has real shell syntax and roughly 77 core utilities, but it does not create OS processes, run a compiler, install npm packages, or run this repository's test suite. The optional `js-exec` group uses QuickJS compiled to WebAssembly; the optional `python` group exposes `python3` backed by CPython/Emscripten. The generated 0.2.1 source itself uses `node:worker_threads` to isolate those interpreters, so the implementation must prove those groups work in workerd rather than assuming that a successful Node-side bundle is enough.

Use the Worker-shell approach for the agent: include only the core plus the explicitly tested `js-exec` and `python` groups, run against the rooted capability filesystem, and do not register the package's built-in git, Assets, Artifacts, or curl commands. This gives the agent useful text transforms and small scripts without a container, keeps the egress boundary closed, and avoids the approximately `$0.129/hour` awake cost and 1–3 second cold start of a standard-2 container. The trade-off is that commands that need native binaries, npm, or a compiler are unavailable.

The container alternative is a real Linux process environment using an amd64 image containing `computerd`; it is the right tool for a genuine `npm test`, but it has a larger capability surface, image and environment credential risks, sleep/cold-start behavior, and the open deployed WebSocket failure described below. If native validation becomes necessary, put a container behind a separately authenticated supervisor-owned validator, never behind the facet's `run` method. That prohibition is ADR-0020 and holds whether or not this migration goes ahead.

The supervisor should run the real replay validation gate itself, using the same production executor and narrow capability path, while the agent's `run` remains file/text work plus small JS/Python. If “real validation suite” means this repository's `pnpm test`, that is a CI/deployment concern: WorkerShell cannot run it and a Worker supervisor cannot spawn it. A container would be required for that meaning, and it should remain outside the agent capability.

**Performance and measurements**

Computer's VFS stores file content in content-addressed 512 KiB chunks in SQLite. Its git wrapper runs isomorphic-git over `@platformatic/vfs`; the package's own git source says that reparsing packs from this SQLite-backed VFS changed a diff from sub-second to minutes, which is why it keeps an unbounded per-client pack/index cache. The cache is reused only if the same `GitClient` instance stays alive, so reconstructing it per request would defeat the fix.

I infer that our intended workload is a favorable case: about ten files, small edits, frequent small commits, and occasional short history walks should mostly use small loose objects and metadata, not large cloned packs. That is an inference, not a benchmark. The VFS still adds SQLite metadata and chunk writes to every file mutation, and the unbounded cache becomes a concern if history grows or a remote clone introduces packs. Computer also has open issues for unreachable GC and unbounded tombstones, so “small” must be measured over the expected retention period, not just the first turn.

Before deleting the codec, add a workerd benchmark that records cold and warm p50/p95/p99 latency and CPU for: ten-file write/add/commit, read, edit, `git log` at depths 1/10/all across 100 and 1,000 commits, generation materialization, and one `run`. Record SQLite byte/table growth, VFS chunk count, and whether the git cache survives the intended supervisor lifetime. Compare the old codec path once before removal. The acceptance bar should be stated from those measurements; do not assume the package's large-repository warning applies unchanged to this small repository.

**Migration slices**

Each slice is independently verifiable. The global gate remains `pnpm test && pnpm typecheck && pnpm lint`; the repository currently has no `test:workers` script, so use the configured workerd Vitest project rather than documenting a nonexistent command.

1. **C0 — record the baseline.** Capture the current full gate and a test inventory before changing imports. A direct declaration scan of this checkout finds 185 `test`/`it` declarations, while the project brief says 198 tests; parameterized expansion may explain the difference, but the implementer must record the actual Vitest count. Verify with `pnpm test && pnpm typecheck && pnpm lint`.
2. **C1 — capability and facet spike first.** Add the four-method proxy and the rooted adapter without changing generation storage. The binding-key assertion in `test/facet/facet-spike.test.ts` changes; its other seven test cases remain and are strengthened. Add the capability, root escape, reserved-path, and no-sixth-method cases. Verify with `pnpm vitest run --config vitest.config.ts test/facet/facet-spike.test.ts && pnpm typecheck`.
3. **C2 — Computer filesystem and git smoke.** Add the exact dependency pin, the flags, top-level exports, and a supervisor-owned `Workspace`; prove persistence across DO requests, ordinary commit, immutable `catFile`/tree reads, and the narrow proxy. The 15 cases in `test/supervisor/supervisor.workers.ts` should still pass except the one direct `DurableObjectSqliteStore` construction, which must use the repository adapter. Verify with `pnpm vitest run test/facet test/supervisor/supervisor.workers.ts && pnpm typecheck`.
4. **C3 — replace generation materialization.** Rewrite `src/generation/build.ts`, `read.ts`, `lineage.ts`, and `genesis.ts` around Computer git. The 4 build, 3 lineage, 3 malformed, 1 read, and 9 genesis test groups keep their domain assertions but construct a real test `Workspace` and test the package's git errors instead of mutating the old object map. The 7 agent-runtime cases and 6 integration cases currently using `MemoryStore` also change fixtures. Remove the 17 codec/oracle declarations from `test/git/`; replace them with workerd generation repository tests covering commit identity, deduplication, executable bits, ancestry, and malformed manifests. Verify with `pnpm vitest run test/generation test/genesis test/agent/runtime.test.ts && pnpm typecheck`.
5. **C4 — remove the old storage surface.** Delete `src/storage/**` and its 8 memory-store and 8 DO-store conformance cases after C3 is green. Update the 9 activation, 10 pointer, and 2 bounded-reset cases to use the memory registry/ledger or a supervisor SQL fixture; their CAS and transaction assertions remain. Validation's 3 result, 2 gate, 3 attestation, 1 promotion, and 11 canary cases should not change semantically. Verify with `pnpm vitest run test/activation test/pointer test/genesis test/validation && pnpm typecheck`.
6. **C5 — replace the tool workspace seam.** Change `src/tools/types.ts` and `primitives.ts` to use the four-method capability, delete `InMemoryWorkspace`, and replace it in `test/tools/*.test.ts` with a small fake capability that has no extra methods. The 5 bash, 7 edit, 2 path-safety, and 6 primitive cases retain their behavior; the 3 workspace implementation cases are removed because the implementation is gone. Update the 7 agent-runtime and 6 integration cases to use the fake only for pure executor tests. Verify with `pnpm vitest run test/tools test/agent/runtime.test.ts && pnpm typecheck`.
7. **C6 — implement narrow WorkerShell `run`.** Reuse Computer's shell modules and Loader framing where possible, but use the four-method rooted capability rather than `WorkerShellBackend`'s broad `WorkspaceServiceProxy` path. Test core commands, QuickJS, CPython/Emscripten, output limits, timeout, `.git` denial, and the absence of git/Assets/Artifacts/curl. Extend the six existing facet cases that test binding and egress instead of weakening them. Verify with `pnpm vitest run --config vitest.config.ts test/facet test/tools/bash.test.ts && pnpm typecheck`.
8. **C7 — move live execution into the facet.** Change `src/agent/loader.ts`, the supervisor's turn path, and the executor adapter so the same candidate executor serves live turns and replay validation. The current 7 agent-runtime cases split into pure loop tests and real facet integration; the 6 vertical integration cases stop passing `InMemoryWorkspace` directly. The supervisor's 15 route cases update only their turn/generation setup and continue proving promotion, rollback, reset, and context/corpus retention. Verify with `pnpm vitest run test/agent test/integration test/facet test/supervisor && pnpm typecheck`.
9. **C8 — final atomicity and clean removal.** Run the full gate, inspect the diff for imports of deleted modules and for any `WorkspaceStub` crossing into generated code, and run a clean install so the exact preview package is actually resolvable. Verify with `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm lint`.

The facet, VFS, git, and WorkerShell slices are testable in local workerd. A real Cloudflare Container image, its amd64 scheduling, its awake/sleep billing, and the deployed container WebSocket path are not; they require a separately authorized deployment check. `wrangler deploy --dry-run` can validate configuration and bundling but cannot prove that production `interceptOutboundHttp` returns a usable WebSocket.

**Risks, version policy, and exit**

Pin the exact npm `@cloudflare/computer@0.2.1` and its compatible `@platformatic/vfs` dependency for the first deployment. Do not use a caret range for a preview package. Track GitHub `main` only in a branch that reruns C1–C8, because the pending release changes container auth, environment inheritance, endpoint names, sync behavior, and capnweb versions. The 0.3.0 env filtering is useful defense in depth, but it does not replace the four-method proxy; 0.2.1 has neither RPC bearer auth nor an env allowlist.

Open issues that affect the decision are [#68 unreachable GC](https://github.com/cloudflare/computer/issues/68), [#67 unbounded VFS tombstones](https://github.com/cloudflare/computer/issues/67), [#106 broken published sqlite shell content](https://github.com/cloudflare/computer/issues/106), [#114 deployed container WebSocket upgrades that never complete](https://github.com/cloudflare/computer/issues/114), and [#105 undocumented `enable_ctx_exports`](https://github.com/cloudflare/computer/issues/105). The preview warning in the package README is accurate; these are operational risks, not reasons to hand the facet a broader capability.

Back out before production data exists by reverting to the old codec and workspace seam. After Computer has stored live generations, backing out is a data migration: walk every registry commit through Computer git, copy its objects into the old object store, restore the old pointer adapter, and preserve registry rows and activation history. It is reversible in git, but it is not an instant deployment rollback. The biggest reason to stop rather than paper over a failure is a failed narrow-boundary proof; a performance miss is manageable only if the benchmark shows the workload cannot meet its latency and memory budget.

**Source references**

The implementation details above come from the unpacked 0.2.1 `dist/index.d.ts`, `dist/git.d.ts`, `dist/backends/worker-shell/index.d.ts`, `dist/backends/container/index.d.ts`, and corresponding JavaScript, plus the repository's `src/git/`, `src/storage/`, `src/tools/`, `src/agent/`, and `src/supervisor/` files. The main-branch source reviewed was `packages/computer/src/workspace.ts`, `src/proxy.ts`, `src/git/index.ts`, `src/backends/worker-shell/worker-shell.ts`, `src/backends/worker-shell/entrypoint.ts`, and `src/backends/container/cloudflare-container.ts`. Cloudflare's current whole-product references were `https://developers.cloudflare.com/dynamic-workers/llms-full.txt` and `https://developers.cloudflare.com/containers/llms-full.txt`.
