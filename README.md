# cf-stumble

cf-stumble is a self-modifying AI coding-agent harness for Cloudflare Workers. The agent definition, including its model loop, tool registry, prompts, skills, policies, and module code, lives in Git. The system materializes that definition as immutable, numbered **generations**, borrowing the recovery model from NixOS.

The agent can change its own definition, but it cannot decide that the change may run. A candidate must pass the validation gate before promotion atomically moves the live pointer. Rollback moves that pointer back. Nothing patches a live definition in place, so an upgrade cannot leave the agent half changed.

## Why it is shaped this way

A self-modifying agent can break the code that would repair it. cf-stumble keeps recovery outside the part the agent can alter.

The supervisor is not agent-authored code. Its Durable Object holds the generation registry, live pointer, accumulated context, and compatibility corpus. The agent runs in an isolated Durable Object facet through the Dynamic Worker Loader, with separate SQLite and no direct supervisor access. It can affect supervisor state only through sanctioned paths that the supervisor validates. That boundary is the safety argument, so the project builds and tests it first (see ADR-0024).

Generation 0 stays pinned and reachable. Reset goes through the supervisor, without running agent code, and is tested against a candidate that cannot load and one that throws during init. An escape hatch the agent can break is no recovery path.

The facet owns the part that must evolve: its model loop, tools, prompts, skills, policies, module code, and work environment. The supervisor keeps recovery authority: the generation registry, live pointer, and validation gate. `read`, `write`, `edit`, and `bash` are the bootstrap tool registry the first generation ships with, not a permanent ceiling on what a later agent definition is allowed to grow into.

## Storage

Authored history uses Git objects. Commits carry content and ancestry; trees are module manifests; modules are blobs. A generation is a numbered attempt to materialize a commit, so one commit can produce several generations. Unchanged modules remain content-addressed and are stored once.

The implementation builds Git objects in memory and stores them directly, without a working tree. That does not limit the facet. The planned Computer integration gives it a mutable work environment, then passes an immutable candidate to the supervisor through a sanctioned boundary that is still being designed.

The live pointer and validation evidence stay outside Git. The pointer is one row in supervisor SQLite, so its switch shares a transaction with the state it names. Validation evidence is a SQLite table keyed by commit sha, because questions such as "every rejected candidate whose failure touched the retry policy" are `WHERE` clauses, not Git history walks.

The project has its own Git object codec instead of isomorphic-git. isomorphic-git exports `writeTree` and `writeCommit`, but it expects a ten-method `FsClient` and writes zlib-compressed loose objects. Using it would mean emulating a filesystem over Durable Object SQLite so Git can emulate a content-addressed store on top of something that already is one. The codec is 614 lines, keeps the four-function store honest, and preserves Git's exact byte format, so isomorphic-git can act as an independent oracle inside workerd. ADR-0009 records the case against the codec and the later measurement that replaced it.

## Documentation

Everything under `docs/agents/` is agent-authored. `docs/` outside that directory is for hand-written human documentation.

- `docs/agents/adr/README.md` indexes current decisions by area. Start there.
- `docs/agents/adr/` is the current decision register, one decision per file. A replacement folds in what still matters and deletes the obsolete ADR; Git keeps the history.
- `docs/agents/design/design-history.md` records the reasoning behind decisions, including changes of mind and their cost.
- `docs/agents/design/slices.md` breaks work into independently verifiable slices with commands that exit 0 or non-zero.
- `docs/agents/design/review-findings.md` records what a green suite does _not_ prove.
- `docs/agents/design/integration-findings.md` records what did and did not compose when the layers first ran end to end.

## Development

```
pnpm install
pnpm test          # both projects: behaviour in workerd, properties in Node
pnpm typecheck     # tsc --noEmit, strict, typed against workers-types
pnpm lint          # oxlint type-aware, --max-warnings=0
```

Tests run in workerd, not Node, and no code imports `node:` builtins. A passing test exercises the runtime that deploys. The codec uses isomorphic-git as its independent oracle because workerd cannot run the `git` binary as a subprocess.

Facets and the Dynamic Worker Loader require Workers Paid to deploy, but they run locally without an account. The isolation tests exercise the real boundary instead of a mock.

## Status

The generation path works end to end. Generation 0 seeds, a turn pins to it, a candidate materializes and passes the ratchet, promotion moves the pointer on a real attestation, the next turn selects the candidate, and rollback restores the prior generation. `test/integration/` covers that path.

Facet isolation runs in workerd. The facet gets separate SQLite, an empty `env` with no `LOADER`, blocked network egress, and no route to the supervisor. Reset survives both a candidate that fails to load and one that throws during init.

Promotion cannot be forged. `POST /promote` accepts only a candidate sha; the supervisor runs the gate and retains the attestation. Privileged routes use a constant-time-compared secret and fail closed. Rollback targets only generations previously recorded as live, and quarantine prevents a known-bad generation from returning.

291 tests pass across 43 files: 269 in workerd, and 22 Hegel property tests in Node (ADR-0008).

**What is honestly not done.** Garbage collection is cut (ADR-0007). The current agent runtime materializes prompt, policy, and skills around the bootstrap four-tool executor, but does not yet load a generation's complete evolvable harness into a facet. The last hop from stored bytes to candidate-owned execution is unexercised. There is no real model provider, `@cloudflare/computer` is not wired as the facet's workspace, the sanctioned candidate-submission boundary is not designed, and nothing has been deployed. `docs/agents/design/review-findings.md` explains what a green suite does not prove.
