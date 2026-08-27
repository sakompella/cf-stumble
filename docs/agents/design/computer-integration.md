# Computer integration plan

This document used to plan a supervisor-owned working tree exposed to the facet through a narrow,
hand-proxied four-method capability, on the premise that a facet holding a real
`@cloudflare/computer` `Workspace` was itself an isolation breach. That premise was wrong — see
`docs/agents/design/design-history.md` and `docs/agents/adr/0024-facet-owns-the-evolvable-harness.md`. The
facet is the mutable, active harness; it is supposed to own a real workspace, real tools, and a
real runtime, and grow all of that as ordinary work. Computer is the intended platform for that
role. What follows separates a historical research snapshot of
`@cloudflare/computer@0.2.1` from the open design question: how does a facet's mutable workspace
hand the supervisor an immutable candidate without ever giving the facet a write path into the
supervisor's own recovery records?

## What Computer is for now: the facet's own work environment

Use a current, exactly pinned `@cloudflare/computer` release to back the facet's durable
filesystem, ordinary Git workflow, and runtime. This is facet-owned mutable state; holding a full
Computer Workspace does not threaten the supervisor unless its bindings also expose supervisor
recovery authority. The candidate and generation registry, activation ledger, validation
evidence, and live pointer remain independent supervisor-owned data.

The exact Cloudflare wiring remains unresolved. Conceptually the facet owns the Computer-backed
workspace rather than calling a supervisor-owned four-method proxy, but whether that means a
binding to a separate workspace Durable Object or another supported arrangement must be checked
against the current Computer API before implementation.

## The question that is actually unresolved: sanctioned candidate submission

The supervisor still needs immutable candidate material — a commit, a tree, an artifact digest —
that it can materialize, validate, and promote without trusting the facet's say-so about what that
material contains. The facet, meanwhile, needs some way to hand that material over without the
handoff becoming a channel the facet can use to mutate supervisor state directly. That boundary is
not designed yet. It needs to be, before any source migration happens, and it is the actual
successor to the question this document used to answer with a four-method proxy.

Two shapes are worth naming as starting points, not as a decision:

- **Push to a remote the supervisor treats as untrusted input.** The facet's Computer workspace
  gets a git remote pointing at something the supervisor listens on. The supervisor never trusts
  bytes because they arrived over that remote — it re-reads the pushed commit through its own git
  read path (`show`, recursive `lsTree`, `catFile`), computes its own digest of what it actually
  read, and only then allocates a generation number and materializes. The remote is a delivery
  mechanism, not an authority; the supervisor's own read is what makes the candidate immutable
  from its point of view.
- **A sanctioned "submit candidate" call.** The facet calls a supervisor-owned entrypoint with a
  sha (or an equivalent reference into its own workspace), and the supervisor pulls the bytes
  itself — from the facet's workspace, treated as read-only source, or from wherever the facet
  published them — rather than accepting a payload the facet asserts is authoritative. The
  difference from a plain RPC is that the call can only ever _propose_ a candidate; it cannot
  touch a registry row, the live pointer, or the activation ledger, because the supervisor's own
  code decides what happens with what it pulled.

Either shape (or some other one) has to satisfy the same audit question named in
`docs/agents/design/review-findings.md`: after the facet uses this pathway, can it mutate or
impersonate the supervisor's candidate/generation records, materialization state, validation
evidence, live pointer, rollback, or genesis reset? If the answer is no, the pathway is sanctioned
regardless of how much filesystem or shell access the facet has elsewhere. If the answer is yes
for any input the facet controls, the pathway is broken regardless of how narrow it looks on
paper — a four-method surface that happens to let the facet drive a promotion is exactly as
dangerous as handing it the promotion route directly.

This is deliberately left as an open design question here rather than a worked slice plan. Picking
a shape means deciding how the supervisor authenticates the facet, how it verifies bytes it did
not itself write, and what happens when a submission is malformed or adversarial — that is real
design work, not something to default into while writing this document.

## What the supervisor still needs, regardless of which submission shape is chosen

- **Its own immutable read path over git bytes.** Whatever arrives, the supervisor should never
  trust a caller's claim about a commit's contents. Reading with `git.show`, recursive `git.lsTree`,
  and `git.catFile` against its own git client — rather than checking out a mutable working tree
  and trusting it — is what lets an attestation bind to bytes the supervisor actually inspected.
- **A registry and ledger that live in its own SQLite**, independent of whatever storage backs the
  facet's workspace. Promotion still has to update the candidate's registry state, the validation
  result, the activation ledger, and the live pointer inside one `ctx.storage.transactionSync()`
  call; nothing about the submission pathway should be allowed to split that transaction.
- **A validation gate with no Computer opinion baked into it.** Baseline ratchets, mandatory
  canaries, `INCONCLUSIVE`, attestation provenance, and the candidate-to-live comparison are
  cf-stumble's rules, not something the package provides.

## Historical research snapshot: `@cloudflare/computer@0.2.1`

These facts were verified against version 0.2.1 during the original design work. They explain the
old plan and identify questions to re-check, but they are not current version guidance. Refresh
the package, source, open issues, and Cloudflare documentation before implementation.

The npm package at `@cloudflare/computer@0.2.1` is MIT-licensed, preview-only, and its
`package.json` has `publishConfig.tag: "unreleased"`. Its `Workspace` constructs
`@cloudflare/dofs`'s SQLite database and a `WorkspaceFilesystem`; `Workspace.git` is opt-in through
`createGitClient()` from `@cloudflare/computer/git`. The git client wraps isomorphic-git over the
workspace filesystem provider, and its public path is `writeFile` → `add` → `commit`, not
`writeTree` or `writeCommit` — a real filesystem, so the ordinary working-tree workflow applies
with no working-tree avoidance required.

The shipped `dist/index.js` shows `WorkspaceStub` exposing `fs`, `runtime`, `git`, `assets`, and
`artifacts`. Its `dist/backends/worker-shell/index.js` passes that whole stub through
`WorkspaceServiceProxy.getWorkspace()` and registers host-forwarded `git`, Assets, and Artifacts
commands. Whatever holds a `WorkspaceStub` gets all of that, including host-forwarded git network
operations — **git clone, fetch, and push execute host-side and bypass a Worker's
`globalOutbound: null`.** That fact matters regardless of who holds the workspace: if the facet's
own Computer workspace ever gets a real git remote, that remote is an egress path independent of
ambient `fetch`/`connect` denial, and it needs to be accounted for in its own right, not assumed
closed because `globalOutbound` is set.

At the time of that review, GitHub `main` at commit
`de87919a4fd37242e960e13b7b3ba802d1eef0a0` contained changes described by release PR
[#112](https://github.com/cloudflare/computer/issues/112) as unreleased `0.3.0`: container bearer
authentication, changed container launch arguments, `/api` replacing `/ws`, and filtered
container environments. The fetched `main` `package.json` still said `0.2.1`, whose RPC had no
bearer authentication or environment allowlist. None of those version or issue states should be
assumed current; the durable lesson is to pin the selected preview release exactly and give every
facet-to-supervisor binding its own authentication.

**Worker wiring facts.** `nodejs_compat` is required by Computer's VFS/git bundle.
`experimental` is required by the Worker-shell backend and the Dynamic Worker Loader path.
`enable_ctx_exports` is required by the package's `ctx.exports.WorkspaceServiceProxy(...)` access
pattern; open issue [#105](https://github.com/cloudflare/computer/issues/105) documents that
omission from the 0.2.1 setup instructions.

**Runtime facts.** The Worker-shell backend is just-bash over a virtual filesystem: real shell
syntax and roughly 77 core utilities, but no OS processes, no compiler, and no npm install. The
optional `js-exec` group runs QuickJS compiled to WebAssembly; the optional `python` group exposes
CPython via Emscripten; the generated source uses `node:worker_threads` to isolate those
interpreters, which needs proving in workerd rather than assumed from a Node-side bundle passing.
The container backend is a real Linux process environment (an amd64 image running `computerd`) —
the only way to run something like this repository's own `pnpm test` — and it carries real
per-hour cost (standard-2 around $0.129/hour while awake, 1–3s cold start) and a larger credential
and image surface than the Worker-shell path.

**Performance facts.** Computer's VFS stores file content in content-addressed 512 KiB chunks in
SQLite. Its own git source notes that reparsing packs from this SQLite-backed VFS changed a diff
from sub-second to minutes, which is why it keeps an unbounded per-client pack/index cache that is
only reused if the same `GitClient` instance stays alive. Whoever owns a long-lived `Workspace`
should benchmark cold and warm latency for small commits, `git log` at increasing depth, and
history growth over the expected retention period before assuming "our workload is small" holds
without measurement. Open issues [#68](https://github.com/cloudflare/computer/issues/68)
(unreachable GC) and [#67](https://github.com/cloudflare/computer/issues/67) (unbounded VFS
tombstones) mean "small" needs re-checking as history accumulates, not just on the first turn.

**Issues open at the time of review:** [#106](https://github.com/cloudflare/computer/issues/106)
(broken published sqlite shell content) and [#114](https://github.com/cloudflare/computer/issues/114)
(deployed container WebSocket upgrades that never complete). Re-check their status before using
them as implementation constraints.

## What still needs to be built, once the submission boundary is designed

This is deliberately not a slice plan. The existing hand-written git codec and object store
(`src/git/`, `src/storage/`) are still real, still tested, and still the current implementation;
nothing here is asking for them to be deleted before there is a replacement design to move to.
Source migration — deciding what the facet's workspace binding actually looks like, choosing and
building the candidate-submission pathway, wiring the supervisor's own git read path over whatever
arrives, and retiring the parts of `src/git/` and `src/storage/` that the chosen design makes
redundant — is future work, gated on resolving the submission boundary above. Planning that
migration in detail before the boundary is chosen would just be re-committing the same mistake
this document made the first time, in a new shape.

## Source references

The verified package facts above come from the unpacked `@cloudflare/computer@0.2.1` `dist/index.d.ts`,
`dist/git.d.ts`, `dist/backends/worker-shell/index.d.ts`, `dist/backends/container/index.d.ts`, and
corresponding JavaScript. The main-branch source reviewed was `packages/computer/src/workspace.ts`,
`src/proxy.ts`, `src/git/index.ts`, `src/backends/worker-shell/worker-shell.ts`,
`src/backends/worker-shell/entrypoint.ts`, and `src/backends/container/cloudflare-container.ts`.
The Cloudflare whole-product references consulted at the time were
`https://developers.cloudflare.com/dynamic-workers/llms-full.txt` and
`https://developers.cloudflare.com/containers/llms-full.txt`.
