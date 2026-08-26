# Decisions

Resolved before any implementation. Each entry states the decision, why, the evidence,
and how expensive it is to reverse. Where a decision genuinely needs the human, it is in
OPEN QUESTIONS at the bottom with the most-reversible option picked as the default.

## Corrections to the source architecture

The source brief made two claims that research contradicts. Both are recorded here rather
than silently worked around.

### D1 — Write our own git object codec; do not build generations on `@cloudflare/computer`'s git client

The brief said to build on "its lazily-bundled isomorphic-git glue". The published package
(`@cloudflare/computer@0.2.1`, marked PREVIEW ONLY, `publishConfig.tag: unreleased`) bundles
isomorphic-git 1.40.0 and exposes `hashObject`, `catFile`, `lsTree`, `updateRef`, `commit`,
`log`, and friends — but **`writeTree` and `writeCommit` are bundled and never exported**, and
its `commit()` goes through the index/working-tree workflow. Writing a commit that points at a
tree we constructed in memory is the single most common operation in this system, and the
public API cannot do it without a working tree, which the design forbids outright.

So: a hand-written codec for the three object types we need. It is roughly 150 lines, has no
dependency surface, and — because we keep git's exact wire format — every encode can be checked
against the real `git` binary in tests. That verification property is worth more than the code
we save by taking a dependency.

`@cloudflare/computer` stays in the design for what it is actually good at: the workspace,
filesystem, and shell that the agent's four primitives sit on. It is not on the path for
generation storage.

Reversal cost: low. The codec sits behind `src/git/`, and nothing above it knows how objects
are encoded.

### D2 — Facets and the Worker Loader get real integration tests, not stubs

The brief said "facets need Paid; stub the facet load behind an interface and test against the
stub". Half right. Hosted Dynamic Workers are Paid-only, but **both features run locally in
workerd with no account at all**, and `@cloudflare/vitest-plugin` understands `worker_loaders`
bindings. So the isolation claim — that a facet cannot read the supervisor's SQLite — is
testable tonight, and that claim is the entire safety argument for self-modification. It would
be daft to stub the one thing most worth proving.

The interface seam stays anyway, because unit tests shouldn't pay workerd startup cost. We get
both: fast stubbed tests everywhere, one real workerd test that proves isolation.

Known limitation: `runInDurableObject` does not reach into facets — facet stubs are `Fetcher`s,
not `DurableObjectStub`s. Facet behaviour is asserted end-to-end through the supervisor.

## Storage model

### D3 — The object store is a dumb content-addressed blob store over full git object bytes

`writeObject(bytes) => Sha`, where `bytes` is the complete git object including its
`"<type> <length>\0"` header, and the returned address is the SHA-1 of exactly those bytes.
That address is therefore a real git object id, byte-identical to what `git hash-object`
produces, while the store itself knows nothing about git.

This is what makes the four-function surface honest: the store is a key-value map from
content hash to bytes, which is precisely the shape Cloudflare Artifacts offers, so the
eventual swap is a swap and not a rewrite.

### D4 — SHA-1, git-compatible, chosen for testability

Not for security. A content-addressed store of our own modules has no adversary, and git
itself still uses SHA-1 for object naming. What we buy is that `git hash-object -t commit`
becomes an oracle: any encoding bug shows up as a hash mismatch against a tool we did not
write. Cross-validation against an independent implementation is the strongest verification
available here, and it is only available if we match git's format exactly.

### D5 — The live pointer is a compare-and-swap, not a bare write

`setPointer(next, expected)` returns false if the current value is not `expected`. Two
concurrent promotions cannot interleave into a lost update, and — importantly — this is
provable in a plain in-memory test with no Durable Object anywhere near it. Atomicity becomes
a property of the interface rather than a property of the deployment environment.

In the DO implementation this maps onto a single conditional `UPDATE ... WHERE sha = ?` and
its row count. Kept as one row in the supervisor's SQLite, per the source design, so a reader
never sees the pointer and the state it names disagree.

### D6 — Multi-write atomicity uses `transactionSync()`, not `blockConcurrencyWhile()`

`blockConcurrencyWhile` stops event delivery; it is not a transaction and does not roll back
partial writes if something throws midway. Promotion touches the pointer row, the generation
history, and the validation table together, so it needs a real transaction.

### D7 — Validation results are a SQLite table keyed by commit sha; no git notes

Straight from the source design and it is right. The queries we want ("every rejected
candidate whose failure touched the retry policy") are `WHERE` clauses, not history walks.
The human-readable summary goes in the commit message where `git log` shows it; the structured
verdict goes in the table.

## Generation semantics

### D8 — A generation is a commit; the manifest is its tree; modules are blobs

Lineage is the commit DAG and comes free. Content addressing means an unchanged module across
fifty generations is stored once. Named generations are refs (`refs/generations/N`), which is
the one place refs are the right tool, because naming is all we ask of them.

### D9 — A turn pins its generation at turn start

A promotion partway through a turn does not migrate the running turn onto new code. The turn
resolves the live pointer once, holds that sha, and finishes on it. Anything else means the
agent's behaviour changes underneath itself mid-reasoning, and the resulting bug reports would
be unreadable. Next turn picks up the new generation.

Reversal cost: low, and the alternative (drain-and-switch) is a strictly later refinement.

### D10 — Config is a typed object in the manifest; no code generation

The brief left open whether config needs codegen. It does not, and adding a codegen step to a
system whose entire point is that code is data would be self-parody. Config is a validated,
versioned, typed record stored as a blob in the manifest tree.

### D11 — State migration is lazy and version-tagged

Facet state carries a schema version. New code migrates on first read, not on promotion.
Promotion stays an atomic pointer swap and never becomes a long-running data operation that
can fail halfway.

### D12 — Generation 0 is pinned and reachable without the agent

Never garbage-collected, reachable through a supervisor-level reset endpoint that does not
route through agent code. If the agent can break the escape hatch, there is no escape hatch.

### D13 — GC is mark-and-sweep over reachability from named generations plus generation 0

Reachability walks commit -> tree -> blob. Anything unreachable from a named generation or
generation 0 is collectable.

## Validation gate

### D14 — Replay is deterministic because recorded model responses are replayed, never re-requested

A recorded session stores the full turn sequence including the model's responses. Replay feeds
those recorded responses back to the agent loop, so no network call happens and there is no
sampling nondeterminism. The agent under test is the only thing that varies — which is exactly
the variable we are trying to measure.

### D15 — A replay case passes on observable effects, not on text equality

Asserting that regenerated prose matches recorded prose would make every case fail on
whitespace. A case asserts on the tool calls the agent makes and the resulting workspace
state: which files were written with what content, which commands ran. Those are the things a
regression would actually break.

### D16 — The gate is a ratchet: previously-passing cases must still pass

Promotion is blocked if any case that passes under the live generation fails under the
candidate. New failures on already-failing cases do not block, so the gate never punishes a
candidate for a pre-existing defect it merely failed to fix.

### D17 — The corpus lives in the supervisor and is never part of a generation

Rolling back must not roll back the evidence used to judge rollbacks. Same for conversation
history and learned project facts.

## OPEN QUESTIONS

Defaults are picked to be cheap to reverse. Flagged for the human.

1. **Replay corpus fidelity.** Recorded sessions are stubbed as a JSON fixture directory with
   a versioned schema. The source brief itself flagged this as the piece most likely to need a
   real conversation rather than an overnight decision, and it is right — the question of how
   much workspace state a case must pin down to be meaningful is a judgement call about what
   regressions we care about catching. Default: fixtures on disk, schema versioned, swap the
   loader later.

2. **Skills as blobs or as a subtree.** Currently one blob per skill under a `skills/` subtree.
   If skills grow to directories with attachments this wants to be nested trees. Cheap to
   change while the corpus is small; note it before it is not.

3. **Whether the agent may promote itself unattended**, or whether promotion always requires an
   out-of-band human ack. Default: the machinery supports unattended promotion and the endpoint
   is there, but nothing calls it automatically. That keeps the interesting capability built
   and the dangerous behaviour off.
