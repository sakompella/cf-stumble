# The generation model

This replaces the original "every commit is a generation" design. Read it before changing `src/generation/`, `src/pointer/`, or the supervisor.

## What changed

The old model numbered every commit by parent-link depth. It failed in two ways.

Depth does not identify an attempt. Build generation 0, build 1 from it, return to 0, then build a different candidate. Both candidates become number 1. A test demonstrated two different generations with the same number.

It also gave the agent no workspace between attempts. The agent needs to make several edits before it tries a result. NixOS works the same way: you can edit `configuration.nix` repeatedly, then `nixos-rebuild` creates a generation.

## The model

A commit is an ordinary commit. The agent can commit whenever it wants. Commits carry content and ancestry.

A generation is one attempted facet materialization for a commit. The registry assigns the next number from a monotonic counter and never reuses it.

This has three consequences:

- The mapping from generation to commit is many-to-one. Trying the same commit twice creates two generations, as `nixos-rebuild` creates a new generation from unchanged configuration. The attempt, rather than the content, is the unit of record.
- Failed attempts consume numbers. A generation that cannot load is still generation 7. Allocate its number and write its row before invoking the loader, so a crash leaves evidence. Reusing or skipping the number would make retries hard to match to logs and make "generation 7" ambiguous.
- Counter order does not describe commit ancestry. Record the data that the commit graph used to imply explicitly.

## Materialization and activation

Materialization is immutable and belongs to a generation. Its terminal states are:

```
loading  ->  load_failed
         ->  loaded  ->  validation_failed
                     ->  validated
```

Activation is repeatable. A validated generation can be promoted, superseded, rolled back to, then promoted again. A mutable `status` column cannot record that sequence, so promotion and rollback events go in an append-only activation ledger.

A generation records what the system tried and the result. The ledger records which generation was live at a given time.

## Ordering

```
1. optional static preflight
2. allocate the generation number and write its row   <- atomic, before loading
3. load it as an isolated candidate facet
4. validate the running candidate
5. promote by atomically switching the live pointer
```

Load before validation: validation before loading only evaluates source or build output, not a running facet. Validate before promotion: loading alone cannot authorize a candidate without removing the supervisor's safety boundary.

## The live pointer

The pointer names a **generation number**, not a commit sha. The system needs to know which attempt is live; a commit sha loses that distinction. The row lives in supervisor SQLite, where the switch shares the Durable Object transaction domain.

Promotion requires a successfully validated target and a promotion record in the activation ledger.

Rollback needs one distinction. Returning to an existing facet is a reactivation of its generation and adds a ledger event. Loading the commit again creates a new generation, because it is a new materialization attempt. Both are valid, but they are different events.

## Attestation contents

A generation number distinguishes attempts but does not identify loaded bytes. An attestation binds the generation number, commit sha, digest of the loaded artifact, baseline generation, corpus version, and gate version.

## What must now be stored explicitly

- **Provenance.** Store the source commit and baseline generation. Counter order gives no causal relationship.
- **Ancestry policy.** Check any "reachable from generation 0" requirement against commit ancestry; generation numbers cannot establish it.
- **Garbage-collection roots.** Generation rows, attestations, and the activation ledger root commits and trees. GC remains deferred, but its root set is now specified.
- **Idempotency.** Durable Object requests may retry. Generation creation takes an idempotency key so retries do not allocate another number, while a requested re-attempt still does.
- **Dedup.** The object store still deduplicates content. The registry must not deduplicate generations because two attempts of one commit are different records.

## Why this is a registry, not tags

The requested phrase was "tags mark generations." The implementation is a **generation registry**: a supervisor SQLite table from number to commit, artifact digest, and materialization state, plus the activation ledger.

Git tags are mutable named refs. The project has no ref store, and refs are not content-addressed, so they do not belong in the four-function object store. The registry must be in SQLite anyway to number generations and switch the pointer in one transaction. Real Git tag refs for outside tools are separate future work.

The number-to-commit mapping is immutable, numbers never repeat, and lifecycle updates are append-only or tightly constrained. A freely editable table would violate this model.
