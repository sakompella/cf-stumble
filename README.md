# cf-stumble

A personal AI coding-agent harness on Cloudflare Workers where the agent's own definition —
its model loop, tool registry, prompts, skills, policies, and module code — is versioned as
immutable **generations**, modelled on NixOS system generations.

The agent can modify itself. A self-modification is a _candidate_ build that must pass a gate
before it can go live. Promotion is an atomic pointer switch. Rollback is the same switch in
reverse. Nothing is edited in place, so there is no state in which the agent is half-upgraded.

## Why it's shaped this way

A self-modifying agent has an obvious failure mode: it breaks itself, and the thing that would
have fixed it is the thing that broke. Three properties are arranged against that.

**The supervisor is not modifiable by the agent.** Generation history, the live pointer, the
accumulated context, and the replay corpus live in a supervisor Durable Object that is deployed
normally. Agent code runs in a Durable Object _facet_ loaded through the Dynamic Worker Loader,
with its own isolated SQLite and no route back to the supervisor's state. That containment is
the entire safety argument, which is why it is the first thing built and tested rather than the
last (see ADR-0024).

**Generation 0 is pinned and always reachable.** It is never garbage-collected, and reset routes
through the supervisor without touching agent code. An escape hatch the agent can break is not
an escape hatch, so it is tested against candidate code that fails to load and candidate code
that throws on init.

**The facet is the mutable half; the supervisor is not.** Model loop, tool registry, prompts,
skills, policies, module code, and the agent's work environment can all change from one candidate
to the next — that evolvability is the point of the project. What stays fixed is the supervisor's
recovery authority: generation history, the live pointer, and the validation gate, none of which
a facet can reach except through the sanctioned build → validate → promote path (see ADR-0024).
`read`, `write`, `edit`, and `bash` are the bootstrap harness the first generation ships with, not
a permanent ceiling on what a later agent definition is allowed to grow into.

## Storage

Generations use the git object model: a generation is a commit, its tree is the module
manifest, and modules are blobs. Lineage is the commit DAG, so it comes free, and content
addressing means an unchanged module across fifty generations is stored once.

There is **no working tree, ever**. Objects are built in memory and written to a
content-addressed store whose entire surface is four functions — `readObject`, `writeObject`,
`readPointer`, `setPointer` — because Cloudflare Artifacts is expected to replace it later.

Two things deliberately sit outside git. The live pointer is one row in the supervisor's
SQLite rather than a git ref, so the switch happens inside the same transaction domain as
everything else and a reader can never see the pointer and the state it names disagree.
Validation results are a SQLite table keyed by commit sha rather than git notes, because the
questions we ask of them ("every rejected candidate whose failure touched the retry policy")
are `WHERE` clauses, not history walks.

We write our own git object codec rather than depending on isomorphic-git. Not because
isomorphic-git can't do this — it exports `writeTree` and `writeCommit`, which take objects
directly and run fine on memfs. The reason is the storage surface: isomorphic-git wants a
ten-method `FsClient` and writes zlib-compressed loose objects into it, which would mean
emulating a filesystem over Durable Object SQLite so git can emulate a content-addressed store
on top of something that already is one. The codec is 614 lines, keeps the four-function store
honest, and because it keeps git's exact byte format the real `git` binary works as an
independent test oracle. See ADR-0009 for the case against the hand-written codec and for the
replacement it was later measured against.

## Documentation

Everything under `docs/agents/` was written by agents working on this project. `docs/` outside
that directory is reserved for hand-written human documentation.

- **`docs/agents/adr/README.md`** — the decision index, grouped by area. Start here.
- **`docs/agents/adr/`** — every resolved design decision, one per file, in a paragraph each. Superseded
  decisions keep their file and say what replaced them, so the corrections where research or
  review contradicted the original architecture stay visible rather than being quietly patched.
- **`docs/agents/design/design-history.md`** — the reasoning behind those decisions: what we thought, what
  changed our mind, and what the change cost. The ADRs carry the position; this carries the arc.
- **`docs/agents/design/slices.md`** — the work broken into independently verifiable slices, each with a
  command that exits 0 or non-zero. No slice whose done condition is prose.
- **`docs/agents/design/review-findings.md`** — what a green test suite does _not_ prove. Read this before
  trusting the validation gate.
- **`docs/agents/design/integration-findings.md`** — what did and did not compose when the layers were first
  driven end to end, including the gaps that remain.

## Development

```
pnpm install
pnpm test          # all 165 tests, inside real workerd
pnpm typecheck     # tsc --noEmit, strict, typed against workers-types
pnpm lint          # oxlint type-aware, --max-warnings=0
```

**Everything runs in workerd.** There is no Node-side test path and nothing imports `node:`
builtins, so a passing test says something about the runtime we actually deploy to. The git
codec's independent oracle is isomorphic-git rather than the `git` binary precisely because a
subprocess cannot run there.

Facets and the Dynamic Worker Loader need Workers Paid to _deploy_, but run locally with no
account at all, so the isolation guarantees are tested for real rather than mocked.

## Status

The generation machinery works end to end. Generation 0 seeds, a turn pins to it, a candidate
builds and is validated through the real ratchet, promotion moves the pointer on a real
attestation, the next turn picks up the candidate, and rollback restores the previous one — all
covered by `test/integration/`.

Facet isolation is proven against real workerd rather than mocked: the facet gets a separate
SQLite database, an empty `env` with no `LOADER`, blocked network egress, no route back to the
supervisor, and reset survives both a candidate that fails to load and one that throws on init.

Promotion cannot be forged: `POST /promote` takes only a candidate sha and the supervisor runs
the gate itself, so the attestation never leaves the process. Privileged routes require a
constant-time-compared secret and fail closed. Rollback is restricted to generations previously
recorded as live, and quarantine stops a known-bad generation returning.

163 tests pass (134 Node, 29 workerd), verified from a cold clone rather than incrementally.

**What is honestly not done.** Garbage collection is deliberately cut (ADR-0007). The agent runtime is
real and shared by the gate and the live path, but it is not yet loaded into a facet through the
Dynamic Worker Loader, so the last hop from stored bytes to sandboxed execution is unexercised.
There is no real model provider, `@cloudflare/computer` is not wired as the workspace backend,
and nothing has been deployed — hosted Dynamic Workers need Workers Paid. See
`docs/agents/design/review-findings.md` for what a green suite does not prove.
