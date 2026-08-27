# Design history

This is the project’s design history: what we thought, what changed our mind, and what the change
cost. `docs/agents/adr/` holds the settled positions, and `docs/agents/domain.md` defines the
terms. This document keeps the reasoning that those short records cannot carry.

The project leaves retractions visible instead of quietly editing them away. Several arcs below
took two or three wrong turns before reaching a defensible position, and those wrong turns explain
why the current decisions exist.

## The brief made two claims research contradicted before any code existed

A Claude Desktop export that sketched this system made two claims that would have broken the plan.
The project checked both before writing source.

It said to build generations on `@cloudflare/computer`'s bundled git client. That package's
wrapper bundles isomorphic-git but only re-exports `hashObject`, `catFile`, `lsTree`,
`updateRef`, `commit`, and `log`, but never `writeTree` or `writeCommit`; its `commit()` also needs
a working tree. The wrapper cannot write a commit pointing at an in-memory tree, the operation this
system needs most often. That finding started the git codec decision. It was correct about the
wrapper but later became an incorrect claim about git itself.

It said facets need Workers Paid, so stub the facet load behind an interface and test against the
stub. Also wrong, in the useful direction: both the Dynamic Worker Loader and facets run locally
in workerd with no Cloudflare account at all, and `@cloudflare/vitest-plugin` understands
`worker_loaders` bindings. The safety argument depends on a facet being unable to read supervisor SQLite or reach supervisor
routes. Testing that claim directly, rather than with a mock, changed the build order: the isolation
spike moved from the final planned slice to the first one.

Cost of getting these right early: none, beyond the research time. Cost of getting them wrong
would have been building eleven slices on top of an isolation claim nobody had actually tested.

## The validation gate was circular, and catching it saved the whole plan

Before any code, the plan was to use recorded model-response replay sessions as the compatibility
corpus: replay a tape against a candidate and check whether it still produces the same effects.

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
not the broader claim readers often attach to "validation." Judging whether a _prompt_ improved
requires live generation against the candidate prompt and trials scored against task invariants. That
is a different mechanism with a different cost model, and the project does not build it. The
compatibility corpus name makes the narrower claim explicit.

This correction changed the project’s direction. Without it, the team would have spent a night
building a validation system that did not exercise prompt changes, while every promotion appeared
validated. A safety mechanism that reports success without testing its premise is worse than one
that visibly breaks.

## The git codec: wrong, then weak, then actually justified, then reversed anyway

The project argued this decision four times. Keeping the rounds separate shows what each correction
changed.

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
particular byte layout; any format gets you dedup if you hash it. Only the third reason, interop, survives. Even that was latent: the codec stores raw uncompressed
rows keyed by sha, while real git expects zlib-deflated files at `objects/ab/cdef…` paths. `git log`
could not read the store without an export step that had never been written.

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
avoidance required. The direction this points in, laid out in `docs/agents/design/computer-integration.md`, is retiring the
614-line codec and the four-function object store in favor of isomorphic-git operating on a
Computer-provided filesystem. That direction is documented but not executed. `src/git/` and `src/storage/` still exist on
`main`. Migration waits for a design for handing an immutable candidate from a facet workspace to
the supervisor.

Three of the four reasons given for the codec were false, circular, or beside the point. The one
that held up, interop, never became operational before the project chose to remove the codec.
That does not make the codec poorly engineered: it typechecks, round-trips, and its mutation tests
discriminate real bugs. It does show how a decision can acquire a sound justification after several
bad ones, then lose force when a changed constraint makes the question irrelevant.

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

The original model made each commit a generation and numbered it by lineage depth. A test built
generation 0, built generation 1 from it, rolled back to 0, then built a different candidate from 0. Both candidates had depth 1 and claimed the same number. Depth describes a graph position, and
a rollback followed by a branch can produce distinct positions at that depth. A generation number
must identify one attempt; lineage depth could not do that.

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

The fix separates two concepts. Materialization is immutable and belongs to the generation: what
was tried and how it ended (`load_failed`, `validation_failed`, or `validated`). Activation can
repeat and belongs in an append-only ledger: what was live and when. The generation record and
ledger answer different questions, so neither can replace the other.

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
needed Node specifically. Collapsing to one `vitest.config.ts` and one `tsconfig.json` found three latent typing bugs:
`globalThis.crypto` and two `TextDecoder({ fatal: true })` calls had only type-checked against
Node's global lib types, which `@cloudflare/workers-types` does not provide. The Node half hadn't just been redundant; it had been
quietly masking bugs in code that only ever needs to run in the one runtime that matters.

## A bootstrap constraint got mistaken for the product

The source brief for the overnight build was a derivative prompt, not the product spec: it told
that night's build to give agent-controlled code exactly four actions — `read`, `write`, `edit`,
`bash` — and nothing else. The historical export lacks role labels and begins mid-conversation, so
it does not establish why that restriction appeared. What is clear is that the derivative prompt
conflicted with the Autolith-inspired product model the human has now reaffirmed: the active
harness is mutable, while the separate recovery authority stays stable.

That conflict went unnoticed almost immediately. The four actions were written up as a permanent
isolation boundary — "the agent action space is permanently limited to `read`, `write`, `edit`,
and `bash`; a facet must never receive a general `@cloudflare/computer` Workspace" — and then
layer after layer treated that sentence as settled product architecture rather than as the shape
of one night's tooling. The WebAssembly shell was justified partly on its own merits and partly
as the thing that keeps a container from ever sitting behind the facet, full stop, rather than as
a bootstrap-runtime choice that a later, more capable runtime could supersede. The `@cloudflare/computer` integration plan inherited the premise and designed a four-method proxy
so the facet would never hold anything Computer calls a `Workspace`. It treated broad tooling as
the danger instead of asking whether those tools reached the supervisor.

Once that premise was in the design, everything downstream entrenched it further, each time
making it harder to notice it was scope, not spec. The primitive-kind union got an `assertNever`
exhaustiveness check, so adding a fifth action failed the build — a genuinely good technique for
enforcing whatever the invariant is, but it was pointed at "four primitives, forever" instead of
at the actual invariant underneath. Slice and verification prose then cited that compiler check as
proof the four-action limit itself was correct, phrases like "the bootstrap tool registry: `read`,
`write`, `edit`, `bash`" got written down as the final state rather than as a description of what
one slice had built so far, and review findings treated a facet holding a real
filesystem and shell as an isolation breach on sight, before asking what it could actually do with
them.

The invariant concerns recovery authority, not a tool count. The facet is the mutable active
harness. It owns the model loop, tools, workspace, runtime, prompts, skills, policy, and modules,
and evolves them as ordinary work. The supervisor is the small stable authority underneath it:
immutable candidate and generation records, materialization, validation evidence, atomic live
selection, rollback, and a genesis reset the facet cannot design around. Containment asks whether
the facet can disable or impersonate that authority. Broad tools, native execution, networking, or
a Computer workspace are not breaches by themselves. `read`/`write`/`edit`/`bash` is the bootstrap
runtime currently implemented in this repository, not the recovery boundary.

The shape this project should have started from was already built and documented elsewhere:
Autolith's split between a mutable active image carrying tools and state and a stable launcher
guarding pristine recovery (`lambda-symbolics/autolith`, `docs/architecture.org` and `AGENTS.md`) is
the same distinction under different names. This correction is recorded in
`docs/agents/adr/0024-facet-owns-the-evolvable-harness.md`. The four stale ADRs that encoded the
fixed-tool facet, supervisor-owned workspace, WebAssembly-only shell, and fixed capability floor
were dropped; this design history preserves why.

## Three decision registers, and the one that had quietly gone wrong

The project accumulated three places where a decision could be recorded, none of them wrong on
its own. `docs/decisions.md` held resolved positions as D1–D17 with reversal costs. A
`decisions.tsv` journal held 53 timestamped rows of decisions and findings from the overnight
build. `docs/adr/` arrived later with the engineering-skills convention and covered much of the
same ground under different numbers. Nothing said which won when they disagreed, and nothing
linked a D-number to the ADR that superseded it.

They disagreed. D8 still read "a generation is a commit; the manifest is its tree" long after
ADR-0002 replaced that model and the glossary was rewritten to say a commit is explicitly _not_ a
generation. A reader starting from `decisions.md` — the file the README pointed at first — would
have built the pre-remodel mental model and found code that contradicted it. The failure is not
that someone forgot to update an entry; it is that two registers of current position cannot both
be current, so one of them is always drifting and there is no moment at which anyone notices.

The tsv had the opposite problem: it was doing two jobs with one schema. Rows like "vendor
anti-slop, adopt via ratchet" are decisions; rows like "DO SQLite fails on large objects with raw
SQLITE_TOOBIG" are findings; the columns could not tell them apart, so both aged the same way and
neither had an owner. Its genuinely irreplaceable content turned out to be small — a branding
convention, the reason an untestable cycle guard exists, and about fifteen evidence citations
that made other decisions checkable — and its chronology was already better served by 224 git
commits covering the same window.

Consolidating onto ADRs cost about thirty rewritten cross-references and found positions that had
been sitting in prose, including one executor for gate and live turns, keeping Git rather than two
SQL tables, and ranking supervisor reachability above egress. It also promoted the WebAssembly-only
shell and fixed capability floor into decisions later dropped when the Autolith-inspired product
boundary was restored. Narrative can hide missing decisions and assumptions that never deserved
decision status, because no check reports when either drifts from the product.

## Reopening the Node test path, narrowly, and what it immediately found

The project deleted the two-runtime setup for a good reason: a Node suite that passed gave no
evidence about workerd and had quietly masked Worker-specific typing errors. So when property-based
testing came up, the obvious move was to run Hegel inside workerd like everything else. That turned
out to be impossible rather than merely awkward. Hegel's generation engine is a native library
reached through FFI, workerd exposes no Node-API and throws on `process.dlopen`, and the entire
`@hegeldev` npm scope is the wrapper plus five per-platform native builds — there is no WASM target
to wait for. The choice was a Node project or no generative testing at all.

What makes the reopening narrow rather than a repeal is that Node may only add a layer over modules
workerd already covers, enforced by `test/docs/props-siblings.test.ts`, which runs in workerd and
fails when a `*.props.test.ts` has no `*.test.ts` beside it. The original failure mode — a green Node
run standing in for evidence about the deployed runtime — cannot recur while that holds, because
nothing is ever covered in Node alone. ADR-0008 carries the amended rule.

The first differential property found what fixed fixtures had missed for months. Generating trees
and checking byte agreement against isomorphic-git found two disagreements: our encoder accepts
tree entry names that git's `verify_path` rejects, and the implementations sort one class of
Unicode names differently. Isomorphic-git is wrong about the second case. ADR-0009 and ADR-0011 use
it as an independent oracle, so a known divergence means a future disagreement needs checking
against git before blaming our codec. Characterisation tests preserve both cases until someone fixes
them; the generator does not hide them.
