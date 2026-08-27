# cf-stumble domain glossary

Single-context repo; see `docs/agents/domain.md` for how skills should read this. Read
`docs/generations.md` and `docs/decisions.md` alongside this file — they carry the reasoning
this glossary states only the conclusion of.

Several terms here were sharpened after an earlier, looser usage turned out to hide a real bug
or a real ambiguity. Where that happened, the rejected word is named and why it lost.

## Generation

**One attempted facet materialization** — one try at loading a specific commit as a running
agent. Not a commit, and not a piece of content.

The earlier model made every commit a generation and numbered generations by walking parent
links (lineage depth). That broke in a way a test now proves: build generation 0, build
generation 1 from it, roll back to 0, then build a *different* candidate from 0 — both
candidates compute depth 1, so two distinct generations claimed the same number. Depth is not
an identity. It also gave the agent nowhere to work, since a system where every commit is a
generation cannot let the agent make three exploratory commits before trying one.

A generation number comes from a monotonic counter that never reuses a value, allocated and
written to the registry *before* the loader runs — so a crash mid-load still leaves a numbered
row rather than a gap. A generation that fails to load still consumes its number, the same way
a NixOS system that will not boot still occupies a slot in the boot menu.

**Generation-to-commit is many-to-one, deliberately.** Attempting the same commit twice produces
two generations, because the unit here is the attempt, not the content. Content dedup still
happens one level down, in the object store.

## Commit

An ordinary git commit: content plus ancestry, nothing else. Under the current design a
commit's tree is the module manifest and its parent is the previous commit in the working
history — but a commit is not itself a generation, activated, or promoted. Only a generation
is any of those things. This distinction is the fix for the bug described above; conflating the
two is the mistake that produced it.

## Materialization

The immutable half of what happens to a generation: the record of what was tried and how it
turned out. States are terminal, not a straight-line pipeline —
`loading -> load_failed`, or `loading -> loaded -> validation_failed`, or
`loading -> loaded -> validated`. Once terminal, a materialization record never changes again.

## Activation

The repeatable half, kept separate from materialization on purpose. A validated generation can
be promoted, superseded by a later promotion, rolled back to, and promoted again — a single
mutable status field on the generation cannot represent that history, so activation lives in its
own **append-only ledger** of promotion and rollback events. A generation record answers "what
did we try and how did it go"; the ledger answers "what was live, and when."

## Promotion

An activation event that atomically switches the live pointer to a generation that has a
successful materialization and at least one attestation the supervisor itself produced. Requires
the target to have been validated; requires nothing from the caller beyond a candidate sha, since
promotion no longer accepts an attestation over the wire (see `docs/review-findings.md`,
"attestation provenance").

## Rollback

An activation event that returns the live pointer to a previously-live generation. Has a
subtlety worth keeping straight: if the target's facet still exists, rollback is a reactivation
of an existing generation — a ledger event, no new number. If the facet has to be loaded again
from scratch, that fresh load is, by this model's own definition, a *new* generation. Both are
legitimate outcomes of the word "rollback"; they must not be conflated with each other.

Rollback requires no attestation, deliberately — recovery has to survive validation itself being
unavailable — but it is restricted to generations previously recorded as live, and blocked for
any generation currently quarantined.

## Reset

The escape hatch: an activation that returns the live pointer to generation 0 (genesis),
bypassing agent code entirely and bypassing quarantine. If the agent could break the path back to
generation 0, there would be no escape hatch, so reset does not route through anything the agent
controls, and it is tested against candidate code that fails to load and candidate code that
throws during init.

## Quarantine

A per-generation flag that blocks a specific generation number from becoming live again, even via
rollback. Exists because rollback alone would let a generation known to be bad silently come
back; quarantine is the guard rail that stops that. Reset ignores quarantine, since otherwise
quarantining generation 0 itself would remove the only guaranteed way back.

## Candidate

A generation undergoing validation, not yet promoted. "Candidate" describes a generation's role
in the promotion flow, not a separate type — the same `GenerationRecord` shape is a candidate
before promotion and simply "the live generation" after.

## Baseline

The live generation a candidate was materialized against and is validated relative to. Stored on
the generation record because counter order is not causal ancestry, so "what was live when this
was built" has to be recorded explicitly rather than inferred.

## Attestation

The record binding a candidate's validation result to the specific reality it was validated
against: candidate sha, baseline generation, the digest of the artifact actually loaded, corpus
version, and gate version. The binding exists to close a time-of-check/time-of-use gap — a
compare-and-swap on the pointer stops two promotions from interleaving, but it does not stop a
promoter from presenting validation evidence for a world that has since moved (a different live
generation, an updated corpus, an older gate).

The attestation used to be something a caller could hand to `/promote`. It no longer is: the
supervisor computes it itself and it never leaves the process, so it cannot be forged. See
`docs/review-findings.md` and D16b in `docs/decisions.md` for why the binding alone, without that
change, proved the shape of a check rather than the guarantee.

## Corpus

The set of replay cases used by the regression gate — recorded sessions the candidate must
reproduce the observable effects of. Deliberately **not** called "the validation corpus" without
qualification, because replay cannot judge whether a prompt got better (see design-history.md);
it is an executor-compatibility corpus.

## Canary

A corpus case marked mandatory, whose identity and expected outcome are pinned in
supervisor-owned state, independent of the corpus's own content hash. A canary must pass
individually on the candidate, never merely "no worse than baseline" — the distinction that
closes the hole where a corpus update could quietly drop the one case that would have caught a
regression while still producing a valid, freshly-computed corpus hash.

## Ratchet

The promotion rule the gate enforces: no corpus case that passes under the live generation may
fail under the candidate. New failures on cases that were already failing do not block —
otherwise the gate would punish a candidate for a pre-existing defect it merely didn't fix.
Ratchet alone, without mandatory canaries, degenerates: an empty or all-failing corpus makes "no
previously-passing case regressed" vacuously true.

## Preflight

A cheap, mandatory capability check that runs before the (expensive) regression gate: does the
candidate still retain the ability to use all four primitives and edit its own definition? A
candidate that has lost the ability to edit code is a dead end regardless of what it might score,
so this is a hard floor, not something the gate maximises. Borrowed from the Darwin Gödel
Machine's practice of cheap gates before expensive evaluation (`docs/prior-art.md`). As of this
writing it is designed (`docs/generations.md` step 1) and under active implementation on an
agent branch not yet merged to `main` — check `docs/slices.md` before assuming it is live.

## Facet

An isolated Durable Object execution context, loaded from stored bytes through the Dynamic
Worker Loader, in which one generation's agent code actually runs. Has its own SQLite, an `env`
containing only what the supervisor deliberately grants, `globalOutbound: null`, and no route
back to the supervisor's routes or storage. This containment is the entire safety argument for
letting an agent modify itself, which is why proving it (D2, D2a, D2b) was the first thing built
rather than the last.

## Supervisor

The Durable Object that is not modifiable by agent code: it holds the generation registry, the
activation ledger, the live pointer, the accumulated context, the corpus, and the routes that
promote, roll back, reset, and quarantine. Deployed normally, never loaded through the Worker
Loader. The load-bearing property is asymmetric: the facet cannot see or reach the supervisor,
but the supervisor decides everything about the facet.

## Live pointer

One row in the supervisor's SQLite naming the currently-active **generation number** — not a
commit sha, because "which generation is live" is the actual question and a commit sha alone
loses which attempt it was. Kept in the same transaction domain as the registry and ledger so a
reader can never observe the pointer and the state it names disagree (D5, D6).

## Registry

The supervisor's table of generation records: number, source commit, baseline, materialization
state, artifact digest, idempotency key. Immutable once terminal; numbers are never reused.

The word "tags" was proposed for this and deliberately rejected. Git tags are refs, refs are
mutable named pointers, and refs aren't content-addressed, so they don't belong in the
content-addressed object store; the registry also has to live in the supervisor's SQLite anyway,
to stay in the same transaction domain as the pointer switch. "Registry" says what it actually
is: an immutable number-to-commit mapping with append-only lifecycle transitions, not a set of
movable labels. Emitting real git tag refs for external tooling to read is a separate, later,
strictly weaker thing than the registry itself.

## Activation ledger

The append-only log of promotion and rollback events — see Activation, above. Distinct from the
registry: the registry says what a generation is, the ledger says when it was live.

## Generation 0 / genesis

The first generation, seeded directly by the supervisor rather than by any candidate build.
Never garbage-collected (GC is deferred entirely, D13), and reachable via reset without agent
code in the path. Functions as the NixOS analogue of the generation you can always boot into no
matter how badly a later one breaks.

## The four primitives

The fixed action space: `read`, `write`, `edit`, `bash` — exactly these four, enforced at compile
time (adding a fifth fails the build at an `assertNever` exhaustiveness check, not merely by
convention or comment). What accumulates across generations is skills, prompts, and policy —
never new primitives. An agent that can add its own tools can add one that escapes the sandbox;
an agent that can only write better instructions for four fixed tools cannot.

Note the wire name for the fourth primitive may become `run` if `@cloudflare/computer` is
adopted as the execution backend (see `docs/computer-integration.md`) — that is a naming change
to the transport, not a fifth primitive, and the plan is explicit that it must be made as one
deliberate compatibility change, not a drift.

## Skills, policy, prompt

The parts of a generation's manifest that are expected to change across generations, as opposed
to the fixed primitives that never do. `prompt.md` and `policy.md` are required modules;
`skills/*.md` are optional. A generation materializing without a required module fails loudly
(`AgentMaterializationError` naming the missing module) rather than running with a silently empty
prompt.

## Turn

One interaction with the agent, from the model's perspective. A turn **pins** its generation:
it resolves the live pointer exactly once at turn start and runs to completion on that sha, even
if a promotion happens while the turn is in progress. Without pinning, a promotion mid-turn would
change the agent's behavior underneath itself mid-reasoning, and any resulting bug report would
be unreproducible.

## Object store / git object codec

The content-addressed layer beneath generations: `readObject` / `writeObject` /
`readPointer` / `setPointer`, over full git object bytes (a blob, tree, or commit, including its
type/length header), addressed by the SHA-1 of exactly those bytes. Hand-written rather than
delegated to isomorphic-git's own on-disk format — see `docs/design-history.md` for the full,
twice-revised argument for why, since an earlier stated reason for this was flatly wrong and was
retracted rather than quietly fixed.

## Workspace — a genuinely overloaded word, read carefully

Two unrelated things currently share this name, and the difference is safety-critical, not
cosmetic.

- **`Workspace` the interface** (`src/tools/types.ts`), used by the four primitives today: four
  methods (`readFile`, `writeFile`, `listFiles`/`exists`, `execute`) over an in-memory or
  facet-local filesystem. This is the narrow thing a facet is allowed to touch.
- **`Workspace` the class**, from `@cloudflare/computer`, proposed in `docs/computer-integration.md`
  but not yet adopted in source. It hands its holder a filesystem root, host-forwarded git,
  Assets, and Artifacts — and git network operations under it run host-side, bypassing
  `globalOutbound: null` entirely (D2a-bis). Handing this class directly to a facet would breach
  containment even with every other setting correct.

If `@cloudflare/computer` is adopted, the design is explicit that the facet must never hold a
`Workspace` instance of the second kind: the supervisor holds it privately and exposes exactly a
four-method proxy shaped like the first kind. Anyone editing this area should say which
"workspace" they mean.

## Working tree

A checked-out, mutable copy of files on a filesystem, as opposed to objects addressed and stored
by content hash. The original design banned working trees entirely — everything built in memory,
written straight to the object store — because the source brief assumed no filesystem was
available. That assumption is what's currently being revisited: with `@cloudflare/computer`
providing a real filesystem, the reason for the ban evaporates, and it was the ban that made
writing a hand-rolled commit codec necessary in the first place (see `docs/design-history.md`).

## TOCTOU (time-of-check/time-of-use)

The gap between validating a candidate and promoting it, during which the world can move — a
different generation could become live, the corpus could be updated, the gate itself could
change. Closed by binding the attestation to all four of candidate sha, baseline generation,
corpus version, and gate version, and having the supervisor compute that attestation itself
rather than accept one from a caller.

## INCONCLUSIVE

The third replay outcome, alongside `PASS` and `FAIL`. Used for tape exhaustion, an unexpected
model request, a timeout, or a malformed response — anything that means the harness didn't get a
clean answer, as opposed to the candidate having behaved wrongly. Collapsing this into an
ordinary failure would make "ran out of tape" indistinguishable from "the candidate regressed",
which would eventually make the gate impossible to diagnose and easy to ignore.

## Executor

The code that turns a sequence of model responses into primitive calls and their effects on a
workspace — the thing the gate and the live path must share. If the gate validates against a
different executor than the one that actually runs turns, the regression suite is forever testing
a stand-in, and every guarantee built on top of it is about the wrong program.
