# The generation model

Supersedes the original "every commit is a generation" design. Read this before touching
`src/generation/`, `src/pointer/`, or the supervisor.

## What changed and why

The first model made **every commit a generation**, numbering them by walking parent links —
lineage depth. Two things were wrong with that.

**Depth is not an identity.** Build generation 0, build 1 from it, then roll back to 0 and build
a _different_ candidate: both candidates report number 1. Proven with a test before this rewrite;
two distinct generations claimed the same number.

**It gave the agent nowhere to work.** If every commit is a generation, the agent cannot make
three edits and then try the result. NixOS does not work that way either — you edit
`configuration.nix` as much as you like, and a generation appears when you `nixos-rebuild`.

## The model

**A commit is an ordinary commit.** The agent commits changes whenever it wants. Commits carry
content and ancestry and nothing else.

**A generation is one attempted facet materialization.** You try to load a facet from some
commit; that attempt is a generation. It gets the next number from a monotonic counter that never
reuses a value.

Three consequences follow directly, and they are the point of the model rather than side effects:

- **Generation to commit is many-to-one.** The same commit attempted twice produces two
  generations. That mirrors `nixos-rebuild` on unchanged config producing a new generation, and it
  is what makes "attempt" the unit rather than "content".
- **Failed attempts still consume numbers.** A generation that fails to load is still generation 7. In NixOS a system that will not boot still occupies a slot in the boot menu. The number is
  allocated and the row written _before_ the loader is invoked, so a crash mid-load leaves
  evidence rather than a hole. Skipping numbers on failure would make retries impossible to
  correlate with logs, and "generation 7" could ambiguously mean several failed attempts.
- **Numbering leaves the DAG entirely.** Counter order is not causal ancestry, so anything that
  used to fall out of the commit graph now has to be stored explicitly (see below).

## Materialization is not activation

This is the distinction the first draft of this rewrite got wrong, and it matters.

**Materialization** is immutable and belongs to the generation. It has terminal states:

```
loading  ->  load_failed
         ->  loaded  ->  validation_failed
                     ->  validated
```

**Activation** is repeatable and does not belong to the generation. A validated generation can be
promoted, superseded, rolled back to, and promoted again. A single mutable `status` column cannot
represent that history, so activation lives in an **append-only ledger** of promotion and
rollback events.

Put plainly: a generation records _what we tried and how it turned out_. The ledger records
_what was live when_.

## Ordering

```
1. optional static preflight
2. allocate the generation number and write its row   <- atomic, before loading
3. load it as an isolated candidate facet
4. validate the running candidate
5. promote by atomically switching the live pointer
```

Materialization must come before behavioural validation: validating before loading proves
something about source or build output, not about the running facet. And validation must come
before promotion — letting a candidate load imply promotion would destroy the safety boundary
that the whole facet design exists to provide.

## The live pointer

The pointer names a **generation number**, not a commit sha. "Which generation is live" is the
actual question, and pointing at a commit loses which attempt it was. It stays one row in the
supervisor's SQLite so the switch remains inside the DO's transaction domain.

Two invariants are enforced on promotion: the target must have a successful validation, and it
must have at least one promotion record in the ledger.

**Rollback has a subtlety worth stating.** If the previous facet still exists and routing simply
returns to it, that is a reactivation of an existing generation — a ledger event, no new number.
If the commit has to be loaded again, that load is a **new generation** by this model's own
definition. Both are legitimate; they must not be conflated.

## The attestation binds more than before

A generation number distinguishes attempts but does not prove which bytes were loaded. So an
attestation binds all of: generation number, commit sha, **the digest of the artifact actually
loaded**, the baseline generation it was validated against, the corpus version, and the gate
version.

## What the DAG used to give us for free, and now must be explicit

Dropping "commit is a generation" costs several properties that came free from the graph. Each
needs deliberate replacement:

- **Provenance.** Store the source commit _and_ the baseline generation a candidate was built
  against. Counter order says nothing about causality.
- **Ancestry policy.** "Reachable from generation 0" can no longer be inferred from generation
  order. If we want that guarantee, it has to be checked against commit ancestry explicitly.
- **Garbage-collection roots.** Generation rows, attestations, and the activation ledger are now
  the roots for commits and trees — not the generation DAG. (GC is still deferred; this is
  written down so a future implementation has an unambiguous root set.)
- **Idempotency.** Durable Object requests get retried. Generation creation takes an idempotency
  key so a retry does not silently allocate a second number, while a deliberate re-attempt still
  can.
- **Dedup.** Content dedup continues to work in the object store. Generation dedup deliberately
  disappears — attempting the same commit twice is _supposed_ to produce two generations.

## On the word "tags"

The requested framing was "tags mark generations". What is actually built is a **generation
registry**: a supervisor SQLite table mapping number to commit, artifact digest and
materialization state, plus the activation ledger.

Calling it tagging would overclaim. Git tags are refs, refs are mutable named pointers, and we
have no ref store — refs are not content-addressed so they do not belong in the four-function
object store. The registry also has to live in SQLite anyway to keep numbering and pointer
switching in one transaction domain. Emitting real git tag refs for external interop is a
separate, later concern.

The number-to-commit mapping is immutable, numbers are never reused, and lifecycle changes are
append-only or tightly constrained transitions. A freely mutable table would be weaker than the
model this claims to be.
