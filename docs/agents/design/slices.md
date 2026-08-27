# Slices

Dependency-ordered. Every slice is done when its stated command exits 0 — no slice whose done
condition is prose. Tests are written before implementation.

Global gate, which must hold after every slice:

```
pnpm test && pnpm typecheck && pnpm lint
```

Status legend: `DONE` / `IN PROGRESS` / `NOT DONE (reason)`.

**Generation model remodelled.** Commits are ordinary commits; a generation is one attempted
facet materialization, numbered from a monotonic registry. See `docs/agents/design/generations.md`. This
replaced lineage-depth numbering, which was not an identity — rolling back and branching gave two
distinct generations both claiming number 1.

**Final state: every slice DONE except garbage collection, which was deliberately cut (ADR-0007).**
The full suite runs as a single `pnpm test`, inside real workerd — there is no separate Node
run and no `test:workers` script; see `docs/agents/design/design-history.md` ("one runtime") for why the
two-runtime split was removed. `pnpm test`, `pnpm typecheck`, and `pnpm lint --max-warnings=0`
are all green, verified from a cold clone (`rm -rf node_modules && pnpm install --frozen-lockfile`),
not just incrementally. See `docs/agents/design/verification.md` for what that check is guarding against and
for the current state of in-flight work not yet reflected here.

Slices S12, S13 and S14 were added after an architectural review and each closed a real hole:
canary identity was controlled by the mutable corpus, the integration test used a scripted
executor rather than the real one, and promotion accepted a forgeable caller-supplied
attestation over unauthenticated routes. See `docs/agents/design/review-findings.md`.

The remaining gaps are honest and recorded: the runtime is real but is not yet loaded into a
facet through the Dynamic Worker Loader, there is no real model provider, `@cloudflare/computer`
is not wired as the workspace backend, and nothing has been deployed.

## Ordering principle (revised after review)

The first draft was twelve horizontal layers with the riskiest claim built last. That is the
wrong shape: it front-loads the work whose outcome is already known and defers the work that
could invalidate everything. Two changes:

1. **The facet isolation spike runs first.** It is the load-bearing safety claim (ADR-0004). If it
   fails, the architecture changes, and every hour spent on layers above it is wasted.
2. **A thin vertical path beats complete horizontal layers.** Once the spike lands, drive one
   end-to-end story through the system — seed generation 0, run a turn pinned to it, validate a
   candidate, promote, run a turn on the new generation, roll back — and only then widen each
   layer. A working narrow path finds integration problems that perfect isolated layers hide.

---

## S0 — Scaffold · DONE

pnpm, TypeScript 7 strict, vitest 4, oxlint type-aware with `--max-warnings=0`.

**Verify:** `pnpm test && pnpm typecheck && pnpm lint`

---

## S0.5 — Facet isolation spike · depends: S0 · DONE (all five claims hold)

Prove the safety claim before building on it. Load agent code through the Worker Loader, mount
it as a Durable Object facet, and demonstrate containment.

Owns `wrangler.jsonc`, `vitest.config.ts`, `src/agent/loader.ts`, `test/facet/`.

Must prove, per ADR-0004 — storage separation alone is a narrower claim than we need:

- A secret written to the supervisor's SQLite is not observable from inside the facet.
- Every capability crossing the boundary is enumerated and each is absent or deliberate:
  bindings, service bindings, outbound `fetch`/`connect` (`globalOutbound: null`), and the
  supervisor's own HTTP routes. An agent that can call the promote endpoint has escaped no
  matter which database it can read.
- Generation 0 reset still works when candidate code fails to load or throws during init. The
  escape hatch has to survive the failure it exists for.

**Verify:** `pnpm vitest run test/facet`

---

## S1 — Git object codec · depends: S0 · DONE

Encode and decode git `blob`, `tree`, and `commit` objects byte-exactly; address by SHA-1 of
the full object bytes including header.

Owns `src/git/`, `test/git/`.

The real `git` binary is an independent oracle (ADR-0011): every object we encode has its id checked
against `git hash-object`, and a repository built entirely by our codec is handed to `git log`
and `git cat-file`. An encoding bug cannot hide behind our own decoder agreeing with our own
encoder.

**Verify:** `pnpm vitest run test/git`

---

## S2 — Storage interface, in-memory implementation, conformance suite · depends: S0 · DONE

The four-function surface (ADR-0009, ADR-0003). Owns `src/storage/`, `test/storage/`.

The deliverable that matters is the **conformance suite** — tests parameterised over a store
factory, which S9 reruns verbatim against Durable Object SQLite. That reuse is what stops the
two implementations from quietly diverging.

**Verify:** `pnpm vitest run test/storage`

---

## S3 — Generation model · depends: S1, S2 · DONE

A generation is a commit whose tree is the module manifest — the pre-remodel model, since
superseded by ADR-0002. Build from named modules, read
back, walk lineage to the root. Owns `src/generation/`.

Must prove: an unchanged module across two generations is stored once (dedup actually
happening, not merely claimed); lineage terminates at generation 0; round-trip without loss;
and malformed trees or modules are rejected with a diagnosable error rather than a crash.

**Verify:** `pnpm vitest run test/generation`

---

## S4 — Promote, rollback, attestation · depends: S2, S3 · DONE

Owns `src/pointer/`.

Must prove, as named tests: a candidate that fails validation leaves the pointer **exactly**
where it was; rollback restores the prior generation; two concurrent promotions from the same
base do not interleave — one wins, one is rejected, the pointer ends on the winner and not in
a torn state.

Promotion consumes an **attestation** bound to candidate sha, live generation, corpus version,
and gate version (ADR-0006), verified inside the same transaction that moves the pointer. A test
must show that an attestation which was valid against a since-superseded live generation is
rejected — that TOCTOU gap is the difference between "validated" and "was validated at some
point, against something".

**Verify:** `pnpm vitest run test/pointer`

---

## S5 — Generation 0 pinning and reset · depends: S3, S4 · DONE

Never collectable, reset bypasses agent code entirely (ADR-0007). Owns `src/generation/genesis.ts`.

**Verify:** `pnpm vitest run test/genesis`

---

## S6 — Session recording format and replay runner · depends: S0 only · DONE

Independent of git, so it parallelises with S1–S2. Owns `src/replay/`, fixtures under
`test/fixtures/sessions/`.

**Scope corrected (ADR-0005):** this is an _executor compatibility_ regression gate, not a quality
gate. Replaying recorded model responses cannot tell you whether a prompt got better — the tape
is an output of the old prompt, so a prompt-only candidate reproduces identical effects and
passes vacuously. What it does catch is a broken edit primitive, a mangled tool-call parser, or
a policy that now refuses what it used to allow. Build it for that, and don't let it wear the
name "validation corpus".

A case pins initial workspace state, captured tool results, seeded randomness, and the clock
(ADR-0014). Outcomes are three-valued — tape exhaustion, an unexpected model request, a timeout,
or a malformed response is `INCONCLUSIVE`, never `FAIL` (ADR-0014).

Must prove: replaying a fixture twice is identical; an unknown schema version is rejected
rather than guessed at; a mutated fixture fails; tape exhaustion reports `INCONCLUSIVE`.

**Verify:** `pnpm vitest run test/replay`

---

## S7 — Regression gate with canaries · depends: S4, S6 · DONE

The ratchet plus the canaries that stop it degenerating (ADR-0005). Owns `src/validation/`.

Must prove: promotion blocked when a case passing on the live generation fails on the
candidate; promotion **allowed** when an already-failing case fails again; a mandatory canary
failing blocks outright rather than fail-no-worse; an empty corpus or an all-failing baseline
yields `INCONCLUSIVE` and refuses promotion instead of vacuously permitting it; results are
keyed by commit sha (ADR-0003) and queryable.

**Verify:** `pnpm vitest run test/validation`

---

## S8 — Vertical integration path · depends: S3, S4, S5, S7 · DONE

One end-to-end story, in a single test file, exercising the whole system in order: seed
generation 0 → run a turn pinned to it (ADR-0002) → build a candidate → validate → promote →
confirm the next turn uses the candidate → roll back → confirm the turn after that is back on
the original.

This is the slice most likely to find something the isolated layer tests all missed, which is
why it is a slice rather than an afterthought.

**Verify:** `pnpm vitest run test/integration`

---

## S9 — Durable Object SQLite store · depends: S2, S0.5 · DONE

S2's conformance suite rerun against real DO SQLite under the workers pool, using
`transactionSync()` (ADR-0003). Owns `src/storage/do-sqlite.ts`.

**Verify:** `pnpm vitest run test/storage-do`

---

## S10 — Supervisor Durable Object and HTTP routes · depends: S4, S7, S9 · DONE

Generation history, live pointer, accumulated context, corpus. Routes to list, promote, roll
back, reset. Owns `src/supervisor/`.

**Verify:** `pnpm vitest run test/supervisor`

---

## S11 — Agent primitives · depends: S6, S0.5 · DONE

The fixed action space: `read`, `write`, `edit`, `bash`, and nothing else ever. What
accumulates across generations is skills, prompts, and policies. Owns `src/tools/` (pure logic,
environment-agnostic over a `Workspace` interface — see CONTEXT.md, "Workspace," for why that
word now needs disambiguating from `@cloudflare/computer`'s class of the same name).

Build only what the vertical path in S8 needs; resist widening this.

**Verify:** `pnpm vitest run test/tools`

---

---

## S12 — Ratchet hardening: canary integrity · depends: S7 · DONE

Added after review. Content-derived corpus versions plus mandatory canaries make a weak corpus
_identifiable_ but not _adequate_ — a hash tells you the input changed, not that it is still
sufficient. Enforces the four conditions from `docs/agents/design/review-findings.md`: canary identity comes
from a trusted side, every required canary passes individually, a corpus update cannot drop or
weaken a canary while producing a fresh valid hash, and a scorer failure is `INCONCLUSIVE`.

The headline test: a candidate that removes the canary catching its own regression must not be
promotable, even with an internally consistent recomputed hash.

**Verify:** `pnpm vitest run test/validation`

---

## S13 — Production agent runtime · depends: S3, S6, S11 · DONE

Added after review, and the slice that makes the system real. Materializes a generation's
modules into a runnable agent definition and executes a turn, dispatching the four primitives
through the production path rather than a scripted stand-in.

The binding constraint: **the validation gate and live execution must use the same executor.**
If they diverge, the regression suite tests a surrogate forever and every guarantee above it is
about the wrong program. A turn also emits a transcript in the replay schema, so a live turn can
become a future regression case.

**Verify:** `pnpm vitest run test/agent`

---

## S14 — Attestation provenance and route authorization · depends: S10, S12 · DONE

The most serious remaining hole. Promotion verifies an attestation, but the supervisor accepts
one **from the caller** over unauthenticated routes, so anyone reaching the Durable Object could
mint a well-formed attestation and promote arbitrary code. The existing tests prove the shape of
the check, not the guarantee.

The fix is structural rather than additive: stop accepting attestations over the wire. `promote`
takes a candidate sha, the supervisor runs the gate itself, and the attestation it computes never
leaves the process — forgery becomes impossible rather than merely detectable, and the TOCTOU
window collapses to zero. Privileged routes then get a constant-time secret check that fails
closed.

Also lands the two rollback guard rails from the review: targets restricted to generations
previously recorded as live, and quarantine so a known-bad generation cannot silently return.

**Verify:** `pnpm vitest run test/supervisor`

---

## S15 — Chunked object storage · depends: S9 · DONE

Durable Object SQLite caps row and BLOB size, so storing each whole git object in one row threw a
raw `SQLITE_TOOBIG` above roughly 2 MB. A self-modifying agent writing a large module would have
blown up the store, and the failure surfaced as an opaque SQLite error rather than anything the
system could reason about. Reproduced in workerd before fixing: 1 MiB and 2.5 MiB succeeded, 4 MiB
threw.

Objects are now split across chunk rows beneath the four-function interface, so the address is
still the SHA-1 of the complete object and no caller can tell. Prior art: `littledivy/durable-git`
chunks at 1 MiB, `@cloudflare/computer` at 512 KiB.

**Verify:** `pnpm test` (the shared conformance suite covers both stores)

---

## S16 — Capability preflight · depends: S13 · DONE

Borrowed from the Darwin Gödel Machine, which rejects a candidate that fails to compile _or has
lost the ability to edit code_ before spending anything on benchmarks. A candidate that can no
longer use its own `edit` primitive is a dead end regardless of how it scores, and discovering
that through a full corpus run is both slow and diffuse.

Preflight drives the real executor — not a second divergent path — and every capability must pass
individually rather than contributing to a score. Safety here is a floor, not something to
maximise, because optimising hard against one benchmark amplifies brittle behaviour.

**Verify:** `pnpm vitest run test/validation`

## Deferred and out of scope

**Garbage collection — deferred deliberately (ADR-0007).** A Durable Object holds 10 GB and
deduplicated module blobs are kilobytes, so there is no storage pressure for a long time.
Meanwhile a root-discovery bug deletes the objects rollback depends on, turning the recovery
mechanism into the thing needing recovery. Bad trade for disk we aren't short of.

**Never tonight, per the source brief:** any UI, `patch.md` support, code-server, GitHub
webhooks, the container backend.

**Not built, and worth being honest about:** judging whether a prompt actually got _better_
needs live generation against the candidate prompt and scored trials over task invariants.
That is a genuinely different mechanism from replay, and calling recorded-response replay a
general validation corpus would paper over the gap (ADR-0005).
