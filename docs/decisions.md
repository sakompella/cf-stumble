# Decisions

Resolved before any implementation. Each entry states the decision, why, the evidence,
and how expensive it is to reverse. Where a decision genuinely needs the human, it is in
OPEN QUESTIONS at the bottom with the most-reversible option picked as the default.

## Corrections to the source architecture

The source brief made two claims that research contradicts. Both are recorded here rather
than silently worked around.

### D1 — Write our own git object codec; do not build generations on `@cloudflare/computer`'s git client

**Corrected after review — the original justification here was wrong and is retracted.**

What this decision first claimed was that a commit pointing at an in-memory tree cannot be
written without a working tree. That is false, and worth stating plainly rather than quietly
editing. isomorphic-git publicly exports `writeTree({ fs, gitdir, tree })` and
`writeCommit({ fs, gitdir, commit })`, both of which take the object directly with no index and
no `add` step, and both work fine against memfs or any `FsClient` shim. `commit()` on memfs
works too. Building the entire DAG in memory with isomorphic-git was always available.

The narrow finding that was actually true: **`@cloudflare/computer@0.2.1`'s wrapper** (PREVIEW
ONLY, `publishConfig.tag: unreleased`) bundles isomorphic-git 1.40.0 but re-exports only
`hashObject`, `catFile`, `lsTree`, `updateRef`, `commit`, `log` and friends — not `writeTree` or
`writeCommit`. So _that wrapper_ is unusable for our purposes. Taking a direct dependency on
isomorphic-git was never blocked.

So the real question was: hand-write a codec, or depend on isomorphic-git directly and give it
a filesystem?

**The actual reason for hand-writing it is the storage surface.** `FsClient` is about ten
methods (`readFile`, `writeFile`, `readdir`, `mkdir`, `stat`, `lstat`, `unlink`, `rmdir`,
`readlink`, `symlink`), and isomorphic-git then lays out zlib-compressed loose objects under
`objects/ab/cdef…` inside whatever backs it. D3's whole premise is that the store is a dumb
content-addressed map of four functions, because Cloudflare Artifacts replaces it later. Taking
the dependency means emulating a filesystem over Durable Object SQLite so that git can emulate a
content-addressed store on top of it — when the thing underneath already is one.

So: a hand-written codec for the three object types we need. It is 614 lines (the original
estimate of 150 was optimistic by a factor of four, which is itself an argument the other way),
has no dependency surface, keeps the four-function store honest, and — because we keep git's
exact wire format — every encode is checked against the real `git` binary in tests.

### D1a — The oracle is isomorphic-git, not the `git` binary

Originally the codec was cross-checked against the real `git` executable. That was a good
oracle and it had one fatal property for this project: it needs a subprocess, so those tests
could only run in Node. Since the whole system deploys to workerd, the codec's correctness was
being proven in a runtime we do not ship to.

isomorphic-git replaces it. It is pure JavaScript, runs inside workerd, and is still a genuinely
independent implementation written by other people, so the evidence is just as good. A prototype
confirmed the two produce byte-identical objects given identical inputs, and the mutation check
survived the swap: padding tree modes to `040000` still makes the nested-tree oracle fail.

That change is what let the entire suite move onto one runtime.

**The case against, which is real.** 614 lines of hand-rolled encoding is meaningful bug
surface, mitigated but not eliminated by the oracle. isomorphic-git is tested across far more
edge cases than ours is. And our codec deliberately rejects `gpgsig` and `encoding` headers, so
it cannot read foreign commits; if packfiles, fetch, or push are ever wanted, the dependency
comes back anyway. This decision is worth revisiting if the storage layer ever stops being the
thing we are protecting.

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

### D2a — Isolation means a capability audit, not just separate SQLite

Stating "the facet has its own SQLite" and calling the agent contained is narrower than the
safety claim actually needs to be. Storage separation is one channel. The others are bindings
passed into the loaded worker, outbound network access, service bindings, and the supervisor's
own HTTP routes — an agent that can `fetch()` the supervisor's promote endpoint has escaped,
regardless of which SQLite database it can see.

So the isolation test enumerates every capability crossing the boundary and asserts each is
either absent or deliberate. `globalOutbound: null` blocks network egress by default. No test
can prove universal non-access, and this one does not claim to; it catches the configuration
mistakes that would quietly invalidate the architecture, which is the realistic threat.

### D2a-bis — The facet gets a four-method capability, never a Workspace

Confirmed by reading `@cloudflare/computer@0.2.1` source: a shell or container holding a Workspace
also holds the filesystem root, host-forwarded git, Assets and Artifacts, and **git network calls
run host-side, bypassing `globalOutbound: null`**. Our egress test would stay green while an agent
exfiltrated over git.

So the supervisor owns the Workspace and exposes exactly four proxied methods matching the four
primitives. This is the first concrete payoff of fixing the action space and never growing it: a
four-method capability can be audited; "a filesystem and a shell" cannot. See
`docs/review-findings.md`.

### D2b — The isolation spike runs first, not last

Originally sequenced as the twelfth slice. That was backwards: it is the claim the entire
design rests on, so discovering it fails after building eleven slices on top of it is the worst
available ordering. It moves to the front as a spike, before the layers that assume it.

## Storage model

### D3 — The object store is a dumb content-addressed blob store over full git object bytes

`writeObject(bytes) => Sha`, where `bytes` is the complete git object including its
`"<type> <length>\0"` header, and the returned address is the SHA-1 of exactly those bytes.
That address is therefore a real git object id, byte-identical to what `git hash-object`
produces, while the store itself knows nothing about git.

This is what makes the four-function surface honest: the store is a key-value map from
content hash to bytes, which is close to the shape Cloudflare Artifacts offers.

One caveat worth writing down before it bites: Artifacts may mint its own identifiers rather
than accepting caller-chosen SHA-1 keys, in which case the adapter needs a git-oid-to-artifact
reference index and the swap is an adapter rather than a drop-in substitution. That does not
change the interface, but "we'll just swap the implementation later" is optimistic and should
not be planned around as free.

Relatedly, git object ids should not leak upward as a generic `Sha` that every layer passes
around. The supervisor's API talks about generations; the fact that a generation is named by a
git oid is the storage layer's business.

### D4 — SHA-1, git-compatible, chosen for testability

Not for security. What we buy is that `git hash-object -t commit` becomes an oracle: any
encoding bug shows up as a hash mismatch against a tool we did not write. Cross-validation
against an independent implementation is the strongest verification available here, and it is
only available if we match git's format exactly.

The limit of that argument, stated so nobody later mistakes it for a security claim: the oracle
justifies trusting our _encoding_, not SHA-1's collision resistance. Content here is
agent-authored, so an agent can in principle influence object ids. Nothing tonight depends on
collision resistance, but if integrity ever becomes load-bearing the answer is to store a
second SHA-256 digest alongside the real git oid rather than to abandon git compatibility.

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

To be explicit about the division of labour, since it caused confusion once already: the CAS in
D5 handles _concurrency_ and is provable in a plain in-memory test, while `transactionSync()`
handles _crash atomicity_ across the several rows a promotion touches. Neither subsumes the
other, and the promote path uses both — the CAS check happens inside the transaction.

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

### D13 — Garbage collection is deferred, deliberately

Mark-and-sweep over reachability from named generations plus generation 0 is the eventual
design, and it is not built tonight. A Durable Object holds 10 GB and generations are
deduplicated module blobs measured in kilobytes, so nothing is under storage pressure for a very
long time. Against that, a root-discovery bug in GC deletes objects that rollback depends on —
it turns the recovery mechanism into the thing that needs recovering. Poor trade for the one
piece of work whose upside is disk space we are not short of.

The design is recorded here so it can be picked up later; the slice is out of scope.

## Validation gate

### D14 — Replay is an _executor compatibility_ gate, not a quality gate

**Revised after review. The original framing was circular and would have wasted the night.**

The plan was "recorded sessions are the validation corpus". That does not work, and the reason
is worth stating plainly: a recorded model response is an output of the _old_ prompt. Replay a
prompt-only candidate — which is the main thing a generation changes — and the tape produces
byte-identical effects, so the case passes without exercising the change at all. The gate would
have rubber-stamped exactly the modifications it exists to police. Worse, a candidate that
reorders its model calls desynchronises from the tape and fails for reasons unrelated to quality.

So replay is scoped to what it can honestly measure: **given a fixed sequence of model
responses, does the candidate's executor still turn them into the same tool calls and the same
final workspace state?** That catches real regressions — a broken edit primitive, a mangled
tool-call parser, a policy that now refuses something it used to allow — and it is deterministic
and cheap. It is a runtime regression suite.

Judging whether a _prompt_ got better needs live generation against the candidate prompt and
scored trials over task invariants. That is a different mechanism with a different cost model,
and it is explicitly not built tonight. The two are kept as separate categories rather than
letting one masquerade as the other.

### D14a — Replay outcomes are three-valued

`PASS` / `FAIL` / `INCONCLUSIVE`. Tape exhaustion, an unexpected model request, a timeout, or a
malformed response is `INCONCLUSIVE` — never an ordinary assertion failure. Collapsing "the
candidate did the wrong thing" into "the harness ran out of tape" would feed the ratchet noise
and eventually block promotions for reasons nobody can diagnose at 4am.

### D14b — Determinism requires pinning more than the model

A recorded session stores the full turn sequence including the model's responses. Replay feeds
those recorded responses back to the agent loop, so no network call happens and there is no
sampling nondeterminism. Beyond the model, a case must also pin the initial workspace state,
captured tool results, seeded randomness, and the clock. Any uncaptured source of variation
turns a regression suite into a flaky one, and a flaky gate gets ignored and then removed.

### D15 — A replay case passes on observable effects, not on text equality

Asserting that regenerated prose matches recorded prose would make every case fail on
whitespace. A case asserts on the tool calls the agent makes and the resulting workspace
state: which files were written with what content, which commands ran. Those are the things a
regression would actually break.

### D16 — The gate is a ratchet: previously-passing cases must still pass

Promotion is blocked if any case that passes under the live generation fails under the
candidate. New failures on already-failing cases do not block, so the gate never punishes a
candidate for a pre-existing defect it merely failed to fix.

### D16a — The ratchet needs mandatory canaries or it degenerates into a rubber stamp

A pure ratchet has a hole: if the corpus is empty, or every baseline case already fails, then
"no previously-passing case regressed" is vacuously true and everything promotes. The failure
mode is silent and gets worse over time, because a corpus that rots into all-failing looks
identical to a corpus that is merely new.

So a set of canary cases is marked mandatory. They must pass on the candidate outright, not
merely fail-no-worse. If the canaries themselves cannot pass on the live generation, the gate
reports `INCONCLUSIVE` and refuses to promote rather than waving it through.

### D16b — Promotion consumes a validation attestation, closing the TOCTOU gap

Validating a candidate and then promoting it are two steps, and between them the world can
move. A compare-and-swap on the pointer stops two promoters both winning, but it does not stop
a promoter from presenting stale validation evidence — a candidate validated against a
different live generation, an older corpus, or a previous version of the gate itself.

Promotion therefore requires an attestation bound to all four of: the candidate sha, the live
generation it was validated against, the corpus version, and the gate version. Promotion
verifies the attestation matches current reality inside the same transaction that moves the
pointer, and rejects it otherwise. Without this, "validated" means "was validated at some point,
against something".

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
