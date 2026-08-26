# Review findings

An architectural review of the finished overnight build. These are the things a green test
suite does *not* prove. Recorded here rather than fixed silently, because several are judgement
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
test proves the *shape* of the check, not the *guarantee* — a perfectly bound result that
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

Content-derived corpus versions plus mandatory canaries make a weak corpus *identifiable*. They
do not make it *adequate*. The hole is only closed if all four of these hold, and they should be
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
was a deliberate trade (D4) and is fine while content is not adversarial — but the content here
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
the correct design (D17) but means an old generation is not automatically safe.

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
