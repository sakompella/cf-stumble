# Slices

Dependency-ordered. Every slice is done when its stated command exits 0 — no slice whose done
condition is prose. Tests are written before implementation.

Global gate, which must hold after every slice:

```
pnpm test && pnpm typecheck && pnpm lint
```

Status legend: `DONE` / `IN PROGRESS` / `NOT DONE (reason)`.

---

## S0 — Scaffold  ·  DONE

pnpm, TypeScript 7 strict, vitest 4, oxlint type-aware. Baseline for everything below.

**Verify:** `pnpm test && pnpm typecheck && pnpm lint`

---

## S1 — Git object codec  ·  depends: S0

Encode and decode git `blob`, `tree`, and `commit` objects byte-exactly, and address them by
SHA-1 of the full object bytes (header included).

Owns `src/git/`.

The verification here is unusually strong and is the reason D4 chose SHA-1: the real `git`
binary is an independent oracle. Every object we encode gets its id checked against
`git hash-object`, and a repository built entirely by our codec is handed to `git log` and
`git cat-file` to confirm real git can read it. An encoding bug cannot hide behind our own
decoder agreeing with our own encoder.

**Verify:** `pnpm vitest run test/git` — including a test that shells out to `git` and
asserts hash agreement on blobs, trees, and commits, and a round-trip property test over
generated objects.

---

## S2 — Storage interface, in-memory implementation, conformance suite  ·  depends: S0

The four-function surface from D3 and D5: `readObject`, `writeObject`, `readPointer`,
`setPointer`.

Owns `src/storage/`.

The deliverable that matters most is not the in-memory implementation, it is the **conformance
suite** — a set of tests parameterised over a store factory that any implementation must pass.
S9 reuses it verbatim against Durable Object SQLite, which is what stops the two
implementations from quietly diverging.

Must prove: content addressing (same bytes in, same address out), that writing an existing
object is a no-op, that reading an unknown address returns undefined, and that `setPointer`
compare-and-swap rejects a stale `expected` value.

**Verify:** `pnpm vitest run test/storage`

---

## S3 — Generation model  ·  depends: S1, S2

A generation is a commit whose tree is the module manifest (D8). Build a generation from a set
of named modules, read it back, and walk lineage to the root.

Owns `src/generation/`.

Must prove: an unchanged module across two generations is stored once (content addressing
actually deduplicating, not just claimed to), lineage walk terminates at generation 0, and a
generation round-trips through the store without loss.

**Verify:** `pnpm vitest run test/generation`

---

## S4 — Promote and rollback  ·  depends: S2, S3

Pointer movement with the failure semantics that make this system safe.

Owns `src/pointer/`.

Must prove, as named tests: a candidate that fails validation leaves the pointer **exactly**
where it was; rollback is the same operation in reverse and restores the prior generation;
two concurrent promotions from the same base do not interleave — one wins, one is rejected,
and the pointer ends on the winner rather than in a torn state.

**Verify:** `pnpm vitest run test/pointer`

---

## S5 — Generation 0 pinning and reset  ·  depends: S3, S4

Generation 0 is never collectable and reset does not route through agent code (D12).

Owns `src/generation/genesis.ts`.

**Verify:** `pnpm vitest run test/genesis`

---

## S6 — Session recording format and replay runner  ·  depends: S0 only

Independent of git entirely, so it runs in parallel with S1–S2.

Owns `src/replay/`, fixtures under `test/fixtures/sessions/`.

A recorded session is a versioned JSON document holding the turn sequence including model
responses (D14). The runner replays it against an agent loop with no network access and
reports pass/fail on observable effects (D15).

Must prove: replaying the same fixture twice gives identical results, an unknown schema
version is rejected rather than guessed at, and a deliberately mutated fixture fails.

**Verify:** `pnpm vitest run test/replay`

---

## S7 — Regression gate  ·  depends: S4, S6

The ratchet from D16.

Owns `src/validation/`.

Must prove: promotion is blocked when a case that passes on the live generation fails on the
candidate; promotion is **allowed** when a case that already failed on the live generation
also fails on the candidate; results are written keyed by commit sha (D7) and are queryable.

**Verify:** `pnpm vitest run test/validation`

---

## S8 — Garbage collection  ·  depends: S3, S5

Mark-and-sweep over reachability from named generations plus generation 0 (D13).

Owns `src/gc/`.

Must prove: an object reachable only from a deleted candidate is collected; every object
reachable from generation 0 survives even when nothing else references it; GC never collects
anything reachable from the live pointer.

**Verify:** `pnpm vitest run test/gc`

---

## S9 — Durable Object SQLite store  ·  depends: S2

The same conformance suite from S2, run against real DO SQLite under
`@cloudflare/vitest-plugin`. Uses `transactionSync()` per D6.

Owns `src/storage/do-sqlite.ts`, `wrangler.jsonc`, `vitest.workers.config.ts`.

**Verify:** `pnpm vitest run --config vitest.workers.config.ts test/storage-do`

---

## S10 — Supervisor Durable Object and HTTP routes  ·  depends: S4, S7, S9

The supervisor holds generation history, the live pointer, accumulated context, and the
corpus. Routes for listing generations, promoting, rolling back, and resetting.

Owns `src/supervisor/`.

**Verify:** `pnpm vitest run --config vitest.workers.config.ts test/supervisor`

---

## S11 — Facet isolation proof  ·  depends: S10

The load-bearing safety claim, tested for real rather than stubbed (D2): load agent code
through the Worker Loader, mount it as a Durable Object facet, and assert the facet **cannot**
read the supervisor's SQLite.

Owns `src/agent/loader.ts`.

This is the highest-value test in the repository. If it does not hold, self-modification is
not safe and the design needs to change rather than ship.

**Verify:** `pnpm vitest run --config vitest.workers.config.ts test/facet`

---

## S12 — Agent primitives  ·  depends: S6, S11

The fixed action space: `read`, `write`, `edit`, `bash` (and nothing else ever, per the
architecture — what accumulates across generations is skills, prompts, and policies).

Owns `src/agent/tools/`.

**Verify:** `pnpm vitest run test/tools`

---

## Explicitly out of scope

Not built tonight, per the source brief: any UI, `patch.md` support, code-server, GitHub
webhooks, the container backend.
