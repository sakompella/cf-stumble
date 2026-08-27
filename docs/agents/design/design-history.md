# Design history

Not a changelog. This is organized by decision: what we thought, what changed our mind, and what
it cost to change it. Read `docs/agents/adr/` for the resolved position on each of these and
`docs/agents/domain.md` for the vocabulary; this document exists to carry the reasoning that a
decision record alone tends to compress away.

The project's own convention is to leave retractions visible rather than edit them quietly. This
document follows that convention on purpose — several of the arcs below took two or three wrong
turns before landing somewhere defensible, and the wrong turns are worth as much as the landing.

## The brief made two claims research contradicted before any code existed

The source document — a Claude Desktop export sketching this system — made two load-bearing
claims that turned out to be wrong, and both were checked before writing a line of source.

It said to build generations on `@cloudflare/computer`'s bundled git client. That package's
wrapper bundles isomorphic-git but only re-exports `hashObject`, `catFile`, `lsTree`,
`updateRef`, `commit`, and `log` — never `writeTree` or `writeCommit`, and its `commit()` needs a
working tree. So the wrapper specifically cannot write a commit pointing at an in-memory tree,
which is the single most common operation this system needs. This became the seed of the git
codec decision, and — as covered below — the finding was real but got overgeneralized into a
false claim about git itself.

It said facets need Workers Paid, so stub the facet load behind an interface and test against the
stub. Also wrong, in the useful direction: both the Dynamic Worker Loader and facets run locally
in workerd with no Cloudflare account at all, and `@cloudflare/vitest-plugin` understands
`worker_loaders` bindings. Isolation — that a facet cannot read the supervisor's SQLite or reach
its routes — is the entire safety argument for letting an agent modify itself. Being able to test
that claim for real, rather than mock it, changed the build order: the isolation spike moved from
the last slice planned to the first thing built (see "facet isolation moves first," below).

Cost of getting these right early: none, beyond the research time. Cost of getting them wrong
would have been building eleven slices on top of an isolation claim nobody had actually tested.

## The validation gate was circular, and catching it saved the whole plan

The plan, before any code, was "recorded model-response sessions are the validation corpus":
replay a session's tape against a candidate and see if it still produces the same effects.

An external review caught that this is circular for the one change that matters most. A recorded
model response is an _output of the old prompt_. Replay that tape against a prompt-only
candidate — the single most common thing a generation changes — and the candidate reproduces
byte-identical effects, because the tape never asked the new prompt anything. The case passes
without exercising the change at all. The gate would have rubber-stamped exactly the class of
modification it exists to police, and it would have done so silently: every promotion would have
looked validated.

The fix was to rescope, not to abandon. Replay is honest about a narrower, still-useful claim:
given a fixed sequence of model responses, does the candidate's _executor_ still turn them into
the same tool calls and the same effects? That catches a broken edit primitive, a mangled
tool-call parser, or a policy that now refuses something it used to allow — real regressions, just
not the one everyone assumes "validation" means. Judging whether a _prompt_ got better needs live
generation against the candidate prompt and scored trials over task invariants, which is a
different mechanism with a different cost model and is explicitly not built. The corpus is named
an executor-compatibility corpus, deliberately, so nobody mistakes what it checks.

This is worth calling the single most important correction in the project's history: it would
have wasted an entire night of building a validation system that validated nothing, and it would
have failed silently rather than loudly, which is the worse of the two ways a safety mechanism can
fail.

## The git codec: wrong, then weak, then actually justified, then reversed anyway

This decision was argued four separate times, and each time is worth keeping distinct because
each correction taught something different.

**First justification (wrong).** "You cannot write a commit pointing at an in-memory tree
without a working tree." Stated as fact, used to justify hand-writing a codec instead of
depending on isomorphic-git. This is false: isomorphic-git publicly exports
`writeTree({ fs, gitdir, tree })` and `writeCommit({ fs, gitdir, commit })`, both of which take
the object directly with no index and no `add` step, and both work against `memfs` or any
`FsClient` shim. The actual, narrower finding — that `@cloudflare/computer`'s wrapper doesn't
expose those two functions — had been generalized into a false claim about git as a whole. When
challenged directly on this, the record was corrected in place rather than quietly edited, and a
throwaway prototype was built to settle it empirically.

**Second justification (weak).** Once the false claim was retracted, three reasons were offered
for keeping the hand-written codec anyway: it lets isomorphic-git serve as an independent
correctness oracle; it gives dedup; it preserves interop with real git tooling. Two of these don't
survive scrutiny. The oracle argument is circular — isomorphic-git is only useful as an oracle
_because_ we chose to copy git's byte format; invent our own record type and there is no external
spec to violate, so the entire class of bug the oracle catches stops existing, and ordinary
round-trip tests would cover what's left. The dedup argument is simply wrong — dedup comes from
content addressing (hash the bytes, use the hash as the key), which has nothing to do with git's
particular byte layout; any format gets you dedup if you hash it. Only the third reason,
interop, survives, and at the time it was purely latent: the codec stores raw uncompressed rows
keyed by sha, while real git wants zlib-deflated files at `objects/ab/cdef…` paths, so `git log`
could not actually be pointed at the store without an export step that had never been written.

**Third justification (the one that actually holds up).** A prior-art survey — commissioned
specifically because "surely someone has done this before" — found that `js-git` had already
implemented our exact invariant: `sha1(codec.frame(object))` over uncompressed framed bytes,
behind duck-typed pluggable storage. It died in 2017 and is unmaintained, but it settles the
design question: the separation of object _format_ from object _storage_ is the same shape every
mature implementation of this idea uses (`go-git`'s `EncodedObjectStorer`, `gix`'s split between
`gix-object` and `gix-odb`, `dulwich`'s `ObjectStore`, Irmin's `Content_addressable.S`), and no
maintained JavaScript package offers it — the maintained JS alternative, isomorphic-git, hard-codes
the loose-object filesystem layout as part of the package rather than exposing format separately
from storage. Separately, reading git's own source confirmed that git hashes the _uncompressed
framed_ bytes and only compresses the on-disk loose-file representation — so storing raw
uncompressed rows was always a canonical representation of a git object, not an approximation or a
shortcut.

**The reversal.** All of that argued for keeping the codec assuming dependencies were something
to avoid. Once that constraint was explicitly lifted — "deps are not an issue, we want to home-roll
as little as possible" — the calculus flips entirely. `@cloudflare/computer` provides a real
filesystem (a Workspace), and against a real filesystem isomorphic-git's ordinary
`writeFile` → `add` → `commit` workflow is exactly the workflow it was built for, no working-tree
avoidance required. The plan as of `docs/agents/design/computer-integration.md` deletes the 614-line codec and
the four-function object store entirely, in favor of isomorphic-git operating on a
Computer-provided filesystem. As of this writing that plan is written but not executed in source —
`src/git/` and `src/storage/` still exist on `main`.

The honest accounting: three of the four reasons ever given for the codec turned out to be either
false, circular, or beside the point, and the one durable reason (interop) was never actually
cashed before the decision to remove the codec was made anyway. That is not a failure of the
codec's engineering — it typechecks, it round-trips, its mutation tests discriminate real bugs —
it is a case study in a decision being re-justified until the justification held, and then being
overtaken by a change in a constraint (dependencies are fine now) that made the whole question
moot in a different direction.

## The "no working tree" rule caused the codec question, and its cause disappeared

The rule "objects are built in memory, never checked out to disk" was inherited directly from the
source brief, which assumed no real filesystem would be available to the supervisor. Every
consequence of that rule — the codec needing to build commits without `add`, without an index,
without a working tree at all — flows from this one assumption.

The moment `@cloudflare/computer` supplies a real Workspace with a real filesystem, the
assumption is false, and the rule it justified has nothing left holding it up. This is the reason
the git-codec question resolved to "adopt isomorphic-git over a real filesystem" rather than to
"write our own smaller record format" (the two live alternatives once dependencies stopped being a
constraint) — the working-tree route is strictly simpler once you have a filesystem to check
things out onto, and simplicity was the whole point of removing the codec.

## Lineage depth is not an identity

The original generation model made every commit a generation, numbered by walking parent links —
lineage depth. A test built specifically to check this constructed generation 0, built generation
1 from it, then rolled back to 0 and built a _different_ candidate from 0: both candidates
computed depth 1, so two distinct generations claimed the same number. Depth is a property of a
position in the graph, and rollback-then-branch produces two different positions at the same
depth. It is not an identity, and treating it as one is a real bug, not a modeling nitpick — a
generation number was supposed to be something you could use to say "this specific attempt," and
it couldn't.

The fix replaces lineage depth with a monotonic counter, and separately drops "every commit is a
generation" in favor of "a generation is one attempted facet materialization" — see
`docs/agents/design/generations.md` for the full model. This also fixed a second problem lineage-depth
numbering had: if every commit is a generation, the agent has nowhere to make exploratory commits
without each one becoming a generation attempt.

## Materialization and activation had to split, because promotion isn't terminal

The first draft of the generation rewrite folded a generation's lifecycle into one status field:
`attempted -> loaded -> validated -> promoted -> superseded`. That looked reasonable until it was
checked against what promotion actually needs to represent: a validated generation can be
promoted, later superseded by a different promotion, rolled back to, and promoted again. Promotion
is not a one-way trip down a pipeline, so a single mutable status column cannot hold its history
without losing information every time it happens twice.

The fix splits the concept in two. Materialization is immutable and belongs to the generation —
what was tried, and how it terminated (`load_failed`, `validation_failed`, or `validated`).
Activation is repeatable and lives in its own append-only ledger — what was live, and when. A
generation record answers one question; the ledger answers a different one; neither can stand in
for the other.

## The four-function store's justification collapsed when Artifacts turned out to be something else

The object store was designed around a specific expectation: Cloudflare Artifacts would
eventually replace the hand-rolled store, so the store's whole interface was kept to four
functions — `readObject`, `writeObject`, `readPointer`, `setPointer` — shaped to be a drop-in
match for whatever Artifacts turned out to offer.

Checking that assumption directly found it doesn't hold. Artifacts is closed beta and offers named
git repositories accessed over the git protocol with tokens — a repo-and-protocol abstraction, not
caller-hash-addressed object storage. Its Workers binding manages named repos and cannot read or
write their files directly. It does not fit the four-function interface at all; there is no
adapter that makes it a drop-in replacement. The interface itself is still a reasonable piece of
design — it kept the storage layer honest and testable independent of anything else — but the
specific justification for building it ("Artifacts will replace this") turned out to describe a
product that doesn't exist in the shape assumed.

## Attestation provenance: bindings only mean something if they can't be forged

Promotion was designed to verify an attestation bound to candidate sha, the live generation
validated against, corpus version, and gate version — closing the TOCTOU gap where validation
evidence for one world gets presented against a different, later world. That binding is real and
it does close that gap.

A final review found the gap it didn't close: the supervisor's routes were unauthenticated, and
`POST /promote` accepted an attestation _from the caller_. A perfectly bound attestation that
anybody can construct proves the shape of a check, not the guarantee behind it — the tests that
exercised the binding were themselves constructing well-formed attestations directly, which is
exactly what an attacker would also do. The fix was structural rather than additive: stop
accepting attestations over the wire entirely. `promote` now takes only a candidate sha; the
supervisor runs the gate itself and the attestation it produces never leaves the process, so
forgery isn't merely detectable, it's impossible. Privileged routes separately gained a
constant-time-compared bearer secret that fails closed.

## Canary integrity: a content hash proves the corpus changed, not that it's still adequate

Mandatory canaries were added to close the hole where an empty or all-failing corpus makes the
ratchet's "nothing regressed" vacuously true. The corpus version was made a content-derived hash
so a change would be detectable.

Review found that detectability isn't adequacy. Canary identity was still sourced from the
mutable corpus itself, so a candidate — or a corpus update made alongside a candidate — could drop
the one canary that would have caught its own regression, recompute a perfectly valid fresh hash,
and pass. A hash proves the corpus is different; it says nothing about whether it's still
sufficient. The fix pins canary identity and expected outcomes in supervisor-owned state,
independent of corpus content, and requires each mandatory canary to pass individually rather than
merely not drag the aggregate below some threshold. The test written to prove this closed is
direct: a candidate that removes the canary catching its own regression must not be promotable,
even with an internally consistent, freshly recomputed corpus hash.

## One runtime, because a test passing in Node proves nothing about workerd

The project ran two test populations for a while: Node, for pure logic and anything needing the
`git` binary as an oracle or `node:fs` to read fixtures; workerd, for everything that needed the
real Dynamic Worker Loader, real facets, or real Durable Object SQLite.

Both of the reasons for the Node half went away together. Once isomorphic-git replaced the `git`
binary as the codec's cross-implementation oracle (a subprocess can't run inside workerd, so the
old oracle could only ever prove the codec correct in a runtime the project doesn't ship to), and
fixture files were imported as JSON instead of read through `node:fs`, nothing left in the suite
needed Node specifically. Collapsing to one `vitest.config.ts` and one `tsconfig.json` immediately
surfaced three latent typing bugs — `globalThis.crypto` and two `TextDecoder({ fatal: true })`
calls — that had only ever type-checked correctly against Node's global lib types, which
`@cloudflare/workers-types` doesn't provide. The Node half hadn't just been redundant; it had been
quietly masking bugs in code that only ever needs to run in the one runtime that matters.

## Three decision registers, and the one that had quietly gone wrong

The project accumulated three places where a decision could be recorded, none of them wrong on
its own. `docs/decisions.md` held resolved positions as D1–D17 with reversal costs. A
`decisions.tsv` journal held 53 timestamped rows of decisions and findings from the overnight
build. `docs/adr/` arrived later with the engineering-skills convention and covered much of the
same ground under different numbers. Nothing said which won when they disagreed, and nothing
linked a D-number to the ADR that superseded it.

They disagreed. D8 still read "a generation is a commit; the manifest is its tree" long after
ADR-0001 was marked superseded, ADR-0002 replaced that model, and the glossary was rewritten to
say a commit is explicitly _not_ a generation. A reader starting from `decisions.md` — the file
the README pointed at first — would have built the pre-remodel mental model and found code that
contradicted it. The failure is not that someone forgot to update an entry; it is that two
registers of current position cannot both be current, so one of them is always drifting and
there is no moment at which anyone notices.

The tsv had the opposite problem: it was doing two jobs with one schema. Rows like "vendor
anti-slop, adopt via ratchet" are decisions; rows like "DO SQLite fails on large objects with raw
SQLITE_TOOBIG" are findings; the columns could not tell them apart, so both aged the same way and
neither had an owner. Its genuinely irreplaceable content turned out to be small — a branding
convention, the reason an untestable cycle guard exists, and about fifteen evidence citations
that made other decisions checkable — and its chronology was already better served by 224 git
commits covering the same window.

Consolidating onto ADRs cost about thirty rewritten cross-references and produced eight new
decision records, five of which were positions that had been sitting in prose all along: one
executor for the gate and live turns, keeping Git at all rather than two SQL tables, ranking
supervisor reachability above egress, the WebAssembly shell, and preflight as a capability floor.
That last group is the real lesson. The decisions were not missing because nobody wrote them
down; they were missing because they had been written down as _narrative_, where a position is
indistinguishable from an observation, and where nothing goes red when the code stops matching.
