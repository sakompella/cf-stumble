# Slices

Dependency-ordered. Every slice is done when its stated command exits 0 — no slice whose done
condition is prose. Tests are written before implementation.

Global gate, which must hold after every slice:

```
pnpm test && pnpm typecheck && pnpm lint
```

Status legend: `DONE` / `IN PROGRESS` / `NOT DONE (reason)`.

## Ordering principle (revised after review)

The first draft was twelve horizontal layers with the riskiest claim built last. That is the
wrong shape: it front-loads the work whose outcome is already known and defers the work that
could invalidate everything. Two changes:

1. **The facet isolation spike runs first.** It is the load-bearing safety claim (D2b). If it
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

Owns `wrangler.jsonc`, `vitest.workers.config.ts`, `src/agent/loader.ts`, `test/facet/`.

Must prove, per D2a — storage separation alone is a narrower claim than we need:
- A secret written to the supervisor's SQLite is not observable from inside the facet.
- Every capability crossing the boundary is enumerated and each is absent or deliberate:
  bindings, service bindings, outbound `fetch`/`connect` (`globalOutbound: null`), and the
  supervisor's own HTTP routes. An agent that can call the promote endpoint has escaped no
  matter which database it can read.
- Generation 0 reset still works when candidate code fails to load or throws during init. The
  escape hatch has to survive the failure it exists for.

**Verify:** `pnpm vitest run --config vitest.workers.config.ts test/facet`

---

## S1 — Git object codec · depends: S0 · DONE

Encode and decode git `blob`, `tree`, and `commit` objects byte-exactly; address by SHA-1 of
the full object bytes including header.

Owns `src/git/`, `test/git/`.

The real `git` binary is an independent oracle (D4): every object we encode has its id checked
against `git hash-object`, and a repository built entirely by our codec is handed to `git log`
and `git cat-file`. An encoding bug cannot hide behind our own decoder agreeing with our own
encoder.

**Verify:** `pnpm vitest run test/git`

---

## S2 — Storage interface, in-memory implementation, conformance suite · depends: S0 · DONE

The four-function surface (D3, D5). Owns `src/storage/`, `test/storage/`.

The deliverable that matters is the **conformance suite** — tests parameterised over a store
factory, which S9 reruns verbatim against Durable Object SQLite. That reuse is what stops the
two implementations from quietly diverging.

**Verify:** `pnpm vitest run test/storage`

---

## S3 — Generation model · depends: S1, S2 · DONE

A generation is a commit whose tree is the module manifest (D8). Build from named modules, read
back, walk lineage to the root. Owns `src/generation/`.

Must prove: an unchanged module across two generations is stored once (dedup actually
happening, not merely claimed); lineage terminates at generation 0; round-trip without loss;
and malformed trees or modules are rejected with a diagnosable error rather than a crash.

**Verify:** `pnpm vitest run test/generation`

---

## S4 — Promote, rollback, attestation · depends: S2, S3 · IN PROGRESS

Owns `src/pointer/`.

Must prove, as named tests: a candidate that fails validation leaves the pointer **exactly**
where it was; rollback restores the prior generation; two concurrent promotions from the same
base do not interleave — one wins, one is rejected, the pointer ends on the winner and not in
a torn state.

Promotion consumes an **attestation** bound to candidate sha, live generation, corpus version,
and gate version (D16b), verified inside the same transaction that moves the pointer. A test
must show that an attestation which was valid against a since-superseded live generation is
rejected — that TOCTOU gap is the difference between "validated" and "was validated at some
point, against something".

**Verify:** `pnpm vitest run test/pointer`

---

## S5 — Generation 0 pinning and reset · depends: S3, S4

Never collectable, reset bypasses agent code entirely (D12). Owns `src/generation/genesis.ts`.

**Verify:** `pnpm vitest run test/genesis`

---

## S6 — Session recording format and replay runner · depends: S0 only · DONE

Independent of git, so it parallelises with S1–S2. Owns `src/replay/`, fixtures under
`test/fixtures/sessions/`.

**Scope corrected (D14):** this is an *executor compatibility* regression gate, not a quality
gate. Replaying recorded model responses cannot tell you whether a prompt got better — the tape
is an output of the old prompt, so a prompt-only candidate reproduces identical effects and
passes vacuously. What it does catch is a broken edit primitive, a mangled tool-call parser, or
a policy that now refuses what it used to allow. Build it for that, and don't let it wear the
name "validation corpus".

A case pins initial workspace state, captured tool results, seeded randomness, and the clock
(D14b). Outcomes are three-valued — tape exhaustion, an unexpected model request, a timeout, or
a malformed response is `INCONCLUSIVE`, never `FAIL` (D14a).

Must prove: replaying a fixture twice is identical; an unknown schema version is rejected
rather than guessed at; a mutated fixture fails; tape exhaustion reports `INCONCLUSIVE`.

**Verify:** `pnpm vitest run test/replay`

---

## S7 — Regression gate with canaries · depends: S4, S6

The ratchet (D16) plus the canaries that stop it degenerating (D16a). Owns `src/validation/`.

Must prove: promotion blocked when a case passing on the live generation fails on the
candidate; promotion **allowed** when an already-failing case fails again; a mandatory canary
failing blocks outright rather than fail-no-worse; an empty corpus or an all-failing baseline
yields `INCONCLUSIVE` and refuses promotion instead of vacuously permitting it; results are
keyed by commit sha (D7) and queryable.

**Verify:** `pnpm vitest run test/validation`

---

## S8 — Vertical integration path · depends: S3, S4, S5, S7

One end-to-end story, in a single test file, exercising the whole system in order: seed
generation 0 → run a turn pinned to it (D9) → build a candidate → validate → promote →
confirm the next turn uses the candidate → roll back → confirm the turn after that is back on
the original.

This is the slice most likely to find something the isolated layer tests all missed, which is
why it is a slice rather than an afterthought.

**Verify:** `pnpm vitest run test/integration`

---

## S9 — Durable Object SQLite store · depends: S2, S0.5 · IN PROGRESS

S2's conformance suite rerun against real DO SQLite under the workers pool, using
`transactionSync()` (D6). Owns `src/storage/do-sqlite.ts`.

**Verify:** `pnpm vitest run --config vitest.workers.config.ts test/storage-do`

---

## S10 — Supervisor Durable Object and HTTP routes · depends: S4, S7, S9

Generation history, live pointer, accumulated context, corpus. Routes to list, promote, roll
back, reset. Owns `src/supervisor/`.

**Verify:** `pnpm vitest run --config vitest.workers.config.ts test/supervisor`

---

## S11 — Agent primitives · depends: S6, S0.5 · IN PROGRESS

The fixed action space: `read`, `write`, `edit`, `bash`, and nothing else ever. What
accumulates across generations is skills, prompts, and policies. Owns `src/agent/tools/`.

Build only what the vertical path in S8 needs; resist widening this.

**Verify:** `pnpm vitest run test/tools`

---

## Deferred and out of scope

**Garbage collection — deferred deliberately (D13).** A Durable Object holds 10 GB and
deduplicated module blobs are kilobytes, so there is no storage pressure for a long time.
Meanwhile a root-discovery bug deletes the objects rollback depends on, turning the recovery
mechanism into the thing needing recovery. Bad trade for disk we aren't short of.

**Never tonight, per the source brief:** any UI, `patch.md` support, code-server, GitHub
webhooks, the container backend.

**Not built, and worth being honest about:** judging whether a prompt actually got *better*
needs live generation against the candidate prompt and scored trials over task invariants.
That is a genuinely different mechanism from replay, and calling recorded-response replay a
general validation corpus would paper over the gap (D14).
