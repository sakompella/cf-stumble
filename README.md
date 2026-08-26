# cf-stumble

A personal AI coding-agent harness on Cloudflare Workers where the agent's own definition —
its prompts, skills, policies, and module code — is versioned as immutable **generations**,
modelled on NixOS system generations.

The agent can modify itself. A self-modification is a *candidate* build that must pass a gate
before it can go live. Promotion is an atomic pointer switch. Rollback is the same switch in
reverse. Nothing is edited in place, so there is no state in which the agent is half-upgraded.

## Why it's shaped this way

A self-modifying agent has an obvious failure mode: it breaks itself, and the thing that would
have fixed it is the thing that broke. Three properties are arranged against that.

**The supervisor is not modifiable by the agent.** Generation history, the live pointer, the
accumulated context, and the replay corpus live in a supervisor Durable Object that is deployed
normally. Agent code runs in a Durable Object *facet* loaded through the Dynamic Worker Loader,
with its own isolated SQLite and no route back to the supervisor's state. That containment is
the entire safety argument, which is why it is the first thing built and tested rather than the
last (see `docs/decisions.md` D2b).

**Generation 0 is pinned and always reachable.** It is never garbage-collected, and reset routes
through the supervisor without touching agent code. An escape hatch the agent can break is not
an escape hatch, so it is tested against candidate code that fails to load and candidate code
that throws on init.

**The action space is fixed at four primitives** — `read`, `write`, `edit`, `bash` — and never
grows. What accumulates across generations is skills, prompts, policies, and context. An agent
that can add its own tools can add one that escapes the sandbox; an agent that can only write
better instructions for four fixed tools cannot.

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

We write our own git object codec rather than using isomorphic-git — the published
`@cloudflare/computer` bundles it but never exports `writeTree`/`writeCommit`, and writing a
commit that points at an in-memory tree is the most common operation in this system. Keeping
git's exact byte format means the real `git` binary works as an independent test oracle.

## Documentation

- **`docs/decisions.md`** — every resolved design decision with its reasoning, evidence, and
  reversal cost. Includes the corrections where research or review contradicted the original
  architecture, kept visible rather than quietly patched.
- **`docs/slices.md`** — the work broken into independently verifiable slices, each with a
  command that exits 0 or non-zero. No slice whose done condition is prose.
- **`decisions.tsv`** — running log of decisions made during implementation.

## Development

```
pnpm install
pnpm test          # vitest, plain Node
pnpm typecheck     # tsc --noEmit, strict
pnpm lint          # oxlint type-aware, --max-warnings=0
```

Workers-side tests run under a separate config against real workerd. Facets and the Dynamic
Worker Loader need Workers Paid to *deploy*, but run locally with no account at all, so the
isolation guarantees are tested for real rather than mocked.

## Status

Early. See `docs/slices.md` for what is done and what is honestly not.
