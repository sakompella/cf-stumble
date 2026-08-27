# Review findings

An architectural review of the finished overnight build. These are the things a green test
suite does _not_ prove. Recorded here rather than fixed silently, because several are judgement
calls for the human and one changes what "validated" means.

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

It does not close the gap where **the evidence was never trustworthy in the first place**. The
bindings only mean something if attestations can be issued exclusively by an authenticated,
independent validator. Today the supervisor's routes are unauthenticated and a caller can
construct a well-formed attestation directly, which is exactly what the tests do. So the current
test proves the _shape_ of the check, not the _guarantee_ — a perfectly bound result that
anybody can mint proves nothing.

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

The corollary is a design constraint on the next slice: **the gate and live execution must use
the same executor implementation.** If they diverge, compatibility validation is forever testing
a surrogate, and the regression suite stops being evidence about the thing that actually runs.

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
general containment proof. A `@cloudflare/computer`-backed `bash` will have its own egress and
its own credentials, and that boundary has not been audited at all. Repeat the audit when the
workspace is wired.

Separately, local workerd does not establish hosted Dynamic Worker behaviour. Nothing here has
run on Cloudflare's infrastructure.

## SHA-1 is an encoding claim, not an identity claim

Byte agreement with `git hash-object` proves the codec is correct. It says nothing about
collision resistance, and the codec uses ordinary SHA-1 without git's collision detection. This
was a deliberate trade (ADR-0011) and is fine while content is not adversarial — but the content here
is agent-authored, so if object identity ever becomes a security boundary, add a second SHA-256
digest rather than relying on the git oid.

## Rollback deserves a guard rail — RESOLVED (S14)

**Update:** rollback targets are now restricted to generations previously recorded as live, and
quarantine is implemented. Reset remains the deliberate escape hatch that bypasses quarantine,
since otherwise quarantining everything would leave no way back. Original analysis below.

Rollback needs no attestation, deliberately, so that recovery survives validation being
unavailable. Two things should temper that:

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

Adopting anti-slop surfaced something unrelated to its own rules: `src/supervisor/supervisor.ts`
is **1755 lines** and carries a file-wide

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

## `@cloudflare/computer` would breach the facet boundary if used naively (open)

Workers Paid became acceptable, so the obvious move was to back the four primitives with a real
`@cloudflare/computer` workspace and finally get a production `bash`. Reading the 0.2.1 source
first turned up a set of capability leaks that would quietly dismantle the isolation the whole
design rests on.

**Egress is not actually closed.** Setting `egress: { mode: "none" }` blocks ambient public
networking, but the backend still grants the internal `computer.internal` route, and **git network
operations execute host-side** — so clone, fetch and push bypass `globalOutbound: null` entirely.
Our facet test asserts that `fetch()` and `connect()` fail; it would keep passing while the agent
exfiltrated through git.

**The workspace surface is much wider than four primitives.** A shell or container reaching a
Workspace gets the filesystem root, host-forwarded git, Assets and Artifacts. `containerEnv` and
any credentials baked into the image are readable by commands. Version 0.2.1 has neither RPC bearer
authentication nor an environment allowlist; both are pending in an unreleased 0.3.0.

**The current model already resists this, by accident of being strict.** An `env: {}` facet cannot
use `WorkerShellBackend` at all, because it has no `LOADER`. Exposing a host-owned Workspace to the
facet would require deliberately adding a capability route back to the supervisor — precisely the
thing ADR-0004 says must not exist.

**So the design is: never hand the facet a Workspace.** Expose a narrow capability with exactly
four methods, matching the four primitives, proxied and policed by the supervisor, which holds the
Workspace itself. This is the first concrete payoff from fixing the action space at four and never
letting it grow: a four-method capability is auditable in a way that "a filesystem and a shell"
never is.

The unglamorous consequence is that `bash` cannot be a passthrough. Whatever the supervisor is
willing to run has to be an explicit, reviewed surface, and `WorkerShellBackend` runs just-bash —
roughly 77 bundled utilities with pipes, redirects and loops, but no OS processes, no compiler and
no arbitrary binaries — while the container backend runs real processes and costs real money
(standard-2 around $0.129/hour while awake, sleeping after idle, cold start 1–3s).

**Maturity argues for patience anyway.** npm is still on 0.2.1 with `publishConfig.tag: unreleased`
while GitHub `main` sits 69 commits ahead behind an unreleased 0.3.0 that changes auth and
environment filtering. Open issues include broken published sqlite, unreachable GC, and unbounded
tombstones. Fine to build a workspace on; not something to make load-bearing for isolation.

## Two known inconsistencies between the code and the model (open)

Both surfaced by cross-checking `CONTEXT.md` against `src/`, which is the main argument for
keeping a glossary at all.

**The vertical integration test still drives the pre-remodel pointer.** `src/integration/turn.ts`
reads the legacy `PointerStore`, receives a commit sha, and calls it a generation. Its only
callers are the integration tests — including `test/integration/vertical-path.test.ts`, whose
entire job is proving the system composes end to end. The supervisor was rewired onto the
generation registry; this helper was not, and because it still typechecks and passes, nothing
complained.

This is the failure mode where a green test is actively misleading rather than merely incomplete:
the headline proof currently validates a design we no longer use. It should be migrated before the
`@cloudflare/computer` work, since migrating a test that already tests the wrong thing just carries
the error forward.

**`Workspace` has five methods; the action space has four.** `src/tools/types.ts` exposes
`readFile`, `writeFile`, `listFiles`, `exists` and `execute`. The four primitives sit _on top_ of
that, so `Workspace` is the substrate rather than the capability.

That naming is a trap aimed squarely at the migration. `docs/computer-integration.md` says to
expose a four-method proxy to the facet; anyone reading "proxy the Workspace" would hand it
`listFiles` and raw `execute` — a materially wider surface than intended. `CONTEXT.md` now
deliberately avoids claiming the interface has four methods.

## Questions still on the human, not the machine (open)

Carried over from `docs/decisions.md` when its resolved decisions moved into `docs/adr/`. These
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
