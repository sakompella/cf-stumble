# Review findings

This is an architectural review of the finished overnight build. It records what a green test
suite does not prove. Several findings need human judgment, and one changes what "validated"
means, so they remain visible instead of being quietly folded into fixes.

## The one that matters most: attestation provenance — RESOLVED (S14)

**Update:** promotion no longer accepts an attestation from the caller at all. `POST /promote`
takes a candidate sha, the supervisor runs the gate itself, and the attestation it computes
never leaves the process — forgery is now structurally impossible rather than merely detectable.
Privileged routes require a constant-time-compared bearer secret and fail closed. Rollback is
restricted to generations recorded as live, and quarantine blocks a known-bad generation from
returning. Original analysis below.

Promotion verifies an attestation bound to candidate sha, the live generation it was validated
against, corpus version, and gate version. That closes the time-of-check/time-of-use gap where
validation evidence could be replayed against a world that has moved.

It does not establish that the evidence was trustworthy. Bindings matter only when an
authenticated, independent validator exclusively issues attestations. The supervisor's routes were
unauthenticated, and a caller could construct a well-formed attestation directly, which is exactly
what the tests did. The test proved the check’s shape, not its guarantee: a result that anyone can
mint provides no evidence.

Concretely, before this is deployed: trace who can mutate corpus and context, submit validation
results, promote, roll back, and reset. Each of those is a privileged operation and none is
currently authorized.

There is a second, subtler version of the same problem. The gate version hashes the policy
descriptor, but if it excludes the runner code, the primitive implementations, the runtime
version, and the configuration, then two runs with the same gate version can legitimately
disagree, and the attestation is binding a value that doesn't capture what actually determined
the outcome.

## "No seam failed" is overstated — RESOLVED (S13)

**Update:** the integration test now drives the real `AgentExecutor` and `materializeGeneration`
instead of a scripted stand-in, and the gate and live paths share one executor behind two model
response sources. What remains unexercised is the Dynamic Worker Loader step — the runtime is
real but is not yet loaded into a facet. Original analysis below.

The vertical integration test skips the most dangerous seam in the system: commit bytes → module
selection → Dynamic Worker Loader → real executor → primitive dispatch. It supplies a scripted
executor instead. Everything the test exercises genuinely composes, but the claim should be read
as "the generation machinery composes", not "the system works end to end".

The next slice needed one constraint: the gate and live execution must use the same executor
implementation. If they diverge, compatibility validation tests a surrogate and the regression
suite no longer provides evidence about the code that runs. ADR-0017 records that rule.

## Canaries don't close the ratchet hole on their own — RESOLVED (S12)

**Update:** two of the four conditions were genuinely unenforced and are now fixed. Canary
identity came from the mutable corpus, and a corpus change only had to produce a new hash.
Canaries are now pinned in supervisor-owned state and must remain present, mandatory and
content-identical. The original analysis is kept below.

Content-derived corpus versions plus mandatory canaries make a weak corpus _identifiable_. They
do not make it _adequate_. The hole is only closed if all four of these hold, and they should be
checked rather than assumed:

- Canary identities and their expected outcomes are controlled independently of the candidate.
- Every required canary must pass **individually**, never merely contribute to an aggregate.
- A corpus update cannot replace or weaken a canary while still producing a fresh, valid hash.
- A failure in the scorer or executor becomes `INCONCLUSIVE`, never `PASS`.

If a candidate can trade a failed canary against other passes, or influence the oracle judging
it, the gate can still permit a regression while reporting success.

## Isolation will need re-auditing once the workspace is real

The capability audit currently proves a list of denied paths against a facet with `env` of `[]`
and `globalOutbound: null`. That result is sound for the configuration tested, and it is not a
general containment proof. Repeat the audit once the facet holds a real `@cloudflare/computer`
workspace, its own egress, and its own runtime.

Separately, local workerd does not establish hosted Dynamic Worker behaviour. Nothing here has
run on Cloudflare's infrastructure.

## The audit question for Computer, or any binding, is recovery authority, not tool breadth (open)

An earlier version of this review treated a facet holding a real `@cloudflare/computer` Workspace
as an isolation breach. Filesystem and shell access looked dangerous, so it proposed a permanent,
narrow hand-proxied method set. That misses what containment must guarantee. The facet is the
mutable active harness and should own its tools, workspace, and runtime. A full Computer workspace
is reasonable; tool breadth is not the hazard.

A containment audit has to answer one question: can the facet, through Computer or any binding it
holds, mutate or impersonate the supervisor's recovery authority, including candidate and
generation records, materialization state, validation evidence, the live pointer, rollback, and
the genesis reset? The facet may read and write its own filesystem, run its own shell, and commit
its own git history without compromising recovery, provided those powers do not reach supervisor
SQLite, the promotion transaction, or the reset path except through sanctioned candidate
submission.

That pathway is where the real work is, and it is not yet designed. `docs/agents/design/computer-integration.md`
names the open questions: how a facet's mutable workspace hands the supervisor immutable candidate
bytes without gaining a write path into the supervisor's own records, and how the supervisor
independently derives their identity and validates what it materializes. Two findings from the
earlier, narrower framing still matter to that design regardless of
how broad the facet's own tooling is: `@cloudflare/computer`'s git client runs network operations
(clone, fetch, push) host-side, bypassing `globalOutbound: null` — so if the facet's workspace ever
gets a real git remote, that remote is a candidate egress and submission path that has to be
audited on its own terms, separately from whatever the facet does with its own files. And version
0.2.1 has neither RPC bearer authentication nor an environment allowlist, so any binding the facet
holds toward the supervisor's process needs its own authentication rather than relying on the
facet's tooling being narrow.

## SHA-1 is an encoding claim, not an identity claim

Byte agreement with `git hash-object` proves the codec is correct. It says nothing about
collision resistance, and the codec uses ordinary SHA-1 without git's collision detection. This
was a deliberate trade (ADR-0011) and is fine while content is not adversarial — but the content here
is agent-authored, so if object identity ever becomes a security boundary, add a second SHA-256
digest rather than relying on the git oid.

## Two codec disagreements the differential property found (open)

Generating trees and checking byte agreement against isomorphic-git found two divergences that the
fixed fixtures had never reached. Both are pinned as characterisation tests in
`test/git/oracle.props.test.ts` that go red when someone fixes them.

**Our encoder writes tree entry names git refuses to read.** `treeNameRejection`
(`src/git/tree.ts:232`) rejects only an empty name, NUL, and `/`. Git's `verify_path` also refuses
`.`, `..`, `.git`, and its NTFS/HFS aliases, and isomorphic-git enforces that list when reading, so
`encodeObject` can produce a tree that real git tooling treats as corrupt. `..` inside a tree is
also a path traversal on checkout. `parseWorkspacePath` rejects traversal one layer up in
`src/tools/`, but the git layer does not, and that matters for the submission boundary: once a facet
submits candidate bytes and the supervisor derives identity through `buildGeneration`, this is a
validation the trusted side is not performing. Fix it in the encoder, where the invariant belongs,
rather than relying on a caller.

**The oracle sorts tree entries wrongly, and we sort them right.** Git orders entries by raw bytes;
isomorphic-git compares names as JavaScript strings, which is UTF-16 code-unit order. The two
disagree exactly when one name holds a supplementary-plane character and another holds
`U+E000`–`U+FFFF`. Our codec sorts by bytes, matching real git, so here the reference implementation
is the one that is wrong. The generators exclude that corner so the differential property remains meaningful. ADR-0009 and
ADR-0011 treat isomorphic-git as an independent oracle, but this known divergence means it is not
authoritative. Check a future disagreement against git's own behaviour before assuming our codec is
wrong.

## Rollback deserves a guard rail — RESOLVED (S14)

**Update:** rollback targets are now restricted to generations previously recorded as live, and
quarantine is implemented. Reset remains the deliberate escape hatch that bypasses quarantine,
since otherwise quarantining everything would leave no way back. Original analysis below.

Rollback needs no attestation so recovery survives an unavailable validation gate. Two constraints
still apply:

- It should be restricted to authenticated operators and to targets **previously recorded as
  live**, rather than arbitrary shas.
- There is no quarantine or revocation, so a generation known to be bad can silently come back.

Also worth thinking about: immutable old code can still become unloadable against newer
persistent state. Rolling back the code does not roll back the state it has to read, which is
the correct design (ADR-0003) but means an old generation is not automatically safe.

## Over-built and under-built

**Over-built:** the ratchet, replay, and attestation machinery, relative to a scripted executor.
There is a lot of policy sitting on top of something that isn't yet running real code.

**Under-built:** the trusted production execution boundary — module materialization, validator
provenance, endpoint authorization, and real workspace capability containment.

## Lint debt worth naming (open)

Adopting anti-slop also found an unrelated problem: `src/supervisor/supervisor.ts` is **1755 lines**
and carries a file-wide

```
/* oxlint-disable eslint/max-lines, eslint/max-lines-per-function,
   eslint/max-classes-per-file, import/max-dependencies, unicorn/no-array-sort */
```

added while building S10. The anti-slop work already cut real complexity out of it — request
bodies are now parsed once into a validated `JsonObject` instead of `unknown` fields being
re-narrowed through many helpers — but the file is still doing storage, routing, promotion,
validation wiring, genesis and facet loading in one place.

That disable is the linter reporting a design problem and being told to be quiet. Splitting the
supervisor along its obvious seams (routing / generation store / promotion) is the fix, and it
was not attempted tonight because it touches the component every workerd test drives.

## Two known inconsistencies between the code and the model (open)

Cross-checking `docs/agents/CONTEXT.md` against `src/` found both, which is why the project keeps a
glossary.

**The vertical integration test still drives the pre-remodel pointer.** `src/integration/turn.ts`
reads the legacy `PointerStore`, receives a commit sha, and calls it a generation. Its only
callers are the integration tests — including `test/integration/vertical-path.test.ts`, whose
entire job is proving the system composes end to end. The supervisor was rewired onto the
generation registry; this helper was not, and because it still typechecks and passes, nothing
complained.

This green test is misleading rather than merely incomplete: the headline proof validates a design
the project no longer uses. Migrate it before the `@cloudflare/computer` work, or that work will
carry the wrong model forward.

**`Workspace` in `src/tools/types.ts` names two different things.** The bootstrap interface
exposes `readFile`, `writeFile`, `listFiles`, `exists` and `execute`; the bootstrap primitives
(`read`, `write`, `edit`, `bash`) sit on top of that as one client of it, not as the whole of it.
That is also the same identifier `@cloudflare/computer` uses for its own, much larger `Workspace`
class. The overlap is confusing and no longer supports an invariant: the facet is expected to own
a real workspace rather than use a fixed method list. Give the two types distinct names before
source migration so a reader can tell this repository's bootstrap workspace shim from Computer's
`Workspace`.

## Questions still on the human, not the machine (open)

Carried over from `docs/decisions.md` when its resolved decisions moved into `docs/agents/adr/`. These
never resolved, so they are not decisions and never became ADRs. Each has a default chosen to be
cheap to reverse, which is what makes leaving them open tolerable rather than negligent.

**How much workspace state must a replay case pin to be meaningful?** Recorded sessions are a
JSON fixture directory with a versioned schema. The source brief flagged this as the piece most
likely to need a real conversation rather than an overnight decision, and it was right: how much
state a case pins is a judgement about which regressions are worth catching, and nobody has made
that judgement yet. Default in place: fixtures on disk, schema versioned, swap the loader later.

**Are skills blobs or a subtree?** Currently one blob per skill under a `skills/` subtree. If a
skill grows into a directory with attachments, this wants nested trees instead. Cheap to change
while the corpus is small, and progressively less so after.

**May the agent promote itself unattended?** The machinery supports unattended promotion and the
endpoint exists, but nothing calls it automatically, which keeps the interesting capability built
and the dangerous behaviour switched off. Turning it on is a decision about risk appetite, not
about code.

## The supervisor is publicly reachable and its credential names nobody (open)

`src/supervisor/worker.ts` forwards every inbound request to the supervisor Durable Object with no
filtering, and `wrangler.jsonc` declares no routes, so a deployment is reachable on a public
`workers.dev` hostname. The bearer check at `supervisor.ts:246` is therefore the entire perimeter in
front of promote, rollback, and reset. It fails closed when the secret is unset, which is the right
default, but a single static shared token is a thin control for operations that install code.

Two specific gaps. Cloudflare documents no way to attribute a request authenticated by a shared
secret to a particular caller, so promotion history records that something authorized the change
rather than who - awkward for a project whose thesis is provenance, and directly relevant to the
unattended-promotion question. And Cloudflare documents no rotation protocol for such a secret, nor
any position on whether one static token is adequate for destructive operations.

The documented remedy has two halves. Making the supervisor reachable only through a service binding
requires `workers_dev: false`, `preview_urls: false`, no `routes`, no Custom Domain, and removal of
any route previously added through the dashboard; the `preview_urls` setting matters because preview
URLs are public when enabled and their default only follows `workers_dev` when left unset. There is
no documented end-to-end command to verify the result, so it has to be checked against the Domains
and Routes inventory. For the human and CI callers that remain, Cloudflare Access fits: an
identity-provider policy identifies humans by email, and a Service Auth policy identifies CI by
service-token ID. That buys the caller identity the bearer token cannot provide. Note that the
`mtls_certificates` binding is outbound-only and does not authenticate inbound callers.

Deliberately deferred. The project is prototyping, nothing is deployed, and the facet has no egress
(`env: {}` and `globalOutbound: null`), so today the exposure is theoretical and the fail-closed
bearer check is proportionate. The remedy above is a config change rather than a design change, so
it stays cheap to apply later. The trigger to apply it is a public deployment or the facet gaining
network access, whichever comes first - not a milestone in its own right.
