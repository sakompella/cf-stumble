# Slices

Dependency ordered. A slice is done only when its command exits 0. Tests come before implementation.

Global gate after every slice:

```
pnpm test && pnpm typecheck && pnpm lint
```

Status: `DONE`, `IN PROGRESS`, or `NOT DONE (reason)`.

Commits are ordinary commits. A generation is one numbered facet materialization attempt from a monotonic registry. This replaced lineage-depth numbering: rollback and branching could otherwise give different generations the number 1. See `docs/agents/design/generations.md`.

**Final state: every slice DONE except garbage collection, which is cut (ADR-0007).** The full suite is one `pnpm test` in workerd. There is no Node run or `test:workers` script. `pnpm test`, `pnpm typecheck`, and `pnpm lint --max-warnings=0` passed from a cold clone after `rm -rf node_modules && pnpm install --frozen-lockfile`. `docs/agents/design/verification.md` explains the check and tracks work that may not yet appear here.

S12, S13, and S14 closed three holes found in review: the mutable corpus controlled canary identity, the integration test used a scripted executor, and promotion accepted a forgeable caller-supplied attestation through unauthenticated routes. See `docs/agents/design/review-findings.md`.

Known gaps remain: the runtime does not load into a facet through the Dynamic Worker Loader, there is no model provider, `@cloudflare/computer` is not the workspace backend, and nothing is deployed.

## Ordering principle

The first draft built twelve horizontal layers and left the riskiest claim until the end. The plan changed for two reasons:

1. **Start with facet isolation.** If the facet can reach supervisor recovery authority, the architecture fails. Test that before investing in layers built on the boundary (see `docs/agents/adr/0024-facet-owns-the-evolvable-harness.md`).
2. **Build a narrow path before widening layers.** Seed generation 0, run a pinned turn, validate a candidate, promote it, run a turn on it, then roll back. This finds integration failures that isolated tests miss.

---

## S0 — Scaffold · DONE

pnpm, TypeScript 7 strict, vitest 4, oxlint type-aware with `--max-warnings=0`.

**Verify:** `pnpm test && pnpm typecheck && pnpm lint`

---

## S0.5 — Facet isolation spike · depends: S0 · DONE (all five claims hold)

Load agent code through the Worker Loader in a Durable Object facet, then prove it cannot reach protected supervisor state.

The spike must show:

- A secret in supervisor SQLite is not observable in the facet.
- Each boundary crossing is absent or intentional: bindings, service bindings, outbound `fetch`/`connect` (`globalOutbound: null`), and the supervisor HTTP routes. An agent that can call promotion has reached the supervisor regardless of database access.
- Generation 0 reset works when candidate code fails to load or throws during init. Recovery must survive the failure it addresses.

**Verify:** `pnpm vitest run test/facet`

---

## S1 — Git object codec · depends: S0 · DONE

Encode and decode git `blob`, `tree`, and `commit` objects byte-exactly, addressed by SHA-1 of full object bytes including the header.

The real `git` binary is the independent oracle (ADR-0011). Check every encoded id with `git hash-object`, then give a repository built by the codec to `git log` and `git cat-file`. The codec cannot hide an error behind its own decoder.

**Verify:** `pnpm vitest run test/git`

---

## S2 — Storage interface, in-memory implementation, conformance suite · depends: S0 · DONE

The four-function surface from ADR-0009 and ADR-0003. Owns `src/storage/` and `test/storage/`.

The conformance suite is parameterized by a store factory. S9 reruns it unchanged against Durable Object SQLite, so the two stores must satisfy the same contract.

**Verify:** `pnpm vitest run test/storage`

---

## S3 — Generation model · depends: S1, S2 · DONE

This slice built the superseded model where a generation was a commit whose tree was the module manifest. It owns `src/generation/`.

Tests require content dedup across two generations, lineage ending at generation 0, lossless round-trips, and diagnosable errors for malformed trees or modules.

**Verify:** `pnpm vitest run test/generation`

---

## S4 — Promote, rollback, attestation · depends: S2, S3 · DONE

Owns `src/pointer/`.

Tests show that a failed candidate leaves the pointer unchanged; rollback restores the prior generation; and two promotions from one base cannot both win. Promotion consumes an **attestation** bound to candidate sha, live generation, corpus version, and gate version (ADR-0006), in the transaction that changes the pointer. An attestation for an old live generation is rejected, closing the check-then-change gap.

**Verify:** `pnpm vitest run test/pointer`

---

## S5 — Generation 0 pinning and reset · depends: S3, S4 · DONE

Generation 0 is never collectible. Reset bypasses agent code (ADR-0007). Owns `src/generation/genesis.ts`.

**Verify:** `pnpm vitest run test/genesis`

---

## S6 — Session recording format and replay runner · depends: S0 only · DONE

Independent of Git, so it can run with S1 and S2. Owns `src/replay/` and fixtures in `test/fixtures/sessions/`.

**Scope corrected (ADR-0005):** replay checks executor compatibility, not prompt quality. A tape records responses from the old prompt, so a prompt-only candidate can reproduce its effects without demonstrating improvement. Replay catches a broken edit primitive, tool-call parser, or policy change that refuses prior work.

A case fixes initial workspace state, tool results, randomness, and the clock (ADR-0014). Tape exhaustion, an unexpected model request, timeout, or malformed response is `INCONCLUSIVE`, never `FAIL` (ADR-0014).

Tests require repeatable fixtures, rejection of an unknown schema version, failure for a mutated fixture, and `INCONCLUSIVE` for tape exhaustion.

**Verify:** `pnpm vitest run test/replay`

---

## S7 — Regression gate with canaries · depends: S4, S6 · DONE

The ratchet and its canaries from ADR-0005. Owns `src/validation/`.

Tests block promotion when a baseline success fails on the candidate; allow an existing failure to fail again; block a required canary outright; and return `INCONCLUSIVE` for an empty corpus or all-failing baseline. Results are keyed by commit sha and queryable (ADR-0003).

**Verify:** `pnpm vitest run test/validation`

---

## S8 — Vertical integration path · depends: S3, S4, S5, S7 · DONE

One test drives the system in order: seed generation 0, run a pinned turn (ADR-0002), build and validate a candidate, promote it, confirm the next turn uses it, roll back, and confirm the following turn returns to the original.

This is a slice because it finds failures that isolated layer tests cannot.

**Verify:** `pnpm vitest run test/integration`

---

## S9 — Durable Object SQLite store · depends: S2, S0.5 · DONE

Reruns S2's conformance suite against Durable Object SQLite in the workers pool with `transactionSync()` (ADR-0003). Owns `src/storage/do-sqlite.ts`.

**Verify:** `pnpm vitest run test/storage-do`

---

## S10 — Supervisor Durable Object and HTTP routes · depends: S4, S7, S9 · DONE

Owns `src/supervisor/`: the generation registry, live pointer, accumulated context, compatibility corpus, and routes to list, promote, roll back, and reset.

**Verify:** `pnpm vitest run test/supervisor`

---

## S11 — Agent primitives · depends: S6, S0.5 · DONE

Bootstrap work, not a permanent limit on facet capability. It added `read`, `write`, `edit`, and `bash`, the four primitives that the initial build wired end to end. The facet may grow its harness across generations. See `docs/agents/design/computer-integration.md` for the intended workspace and runtime, and `docs/agents/design/design-history.md` for the correction to the earlier "nothing else, ever" claim. Owns `src/tools/`, pure logic over a `Workspace` interface; `docs/agents/CONTEXT.md` distinguishes the Agent workspace from `@cloudflare/computer`'s API.

S8 needed these four primitives. Expanding the tool registry is expected later work.

**Verify:** `pnpm vitest run test/tools`

---

## S12 — Ratchet hardening: canary integrity · depends: S7 · DONE

Content-derived corpus versions identify input changes, but a hash cannot establish that a corpus remains sufficient. The slice enforces the four conditions in `docs/agents/design/review-findings.md`: canary identity comes from a trusted source, each required canary passes, corpus updates cannot remove or weaken a canary while producing a valid new hash, and scoring failure is `INCONCLUSIVE`.

The headline test blocks a candidate that removes the canary that finds its regression, even with a recomputed internal hash.

**Verify:** `pnpm vitest run test/validation`

---

## S13 — Production agent runtime · depends: S3, S6, S11 · DONE

Materializes a generation's modules into a runnable agent definition and executes a turn through the production path, dispatching the four primitives instead of a scripted executor.

The validation gate and live turns use the same executor. If they differ, validation checks a different program. A turn emits a replay-schema transcript, which can become a compatibility case.

**Verify:** `pnpm vitest run test/agent`

---

## S14 — Attestation provenance and route authorization · depends: S10, S12 · DONE

Promotion used to accept a caller-supplied attestation through unauthenticated routes. Anyone who reached the Durable Object could create one and promote arbitrary code. The tests checked attestation shape, not its source.

`promote` now accepts a candidate sha. The supervisor runs the gate and keeps its attestation in-process. Privileged routes use a constant-time secret check that fails closed. Rollback targets must have been live, and quarantine prevents a known-bad generation from returning.

**Verify:** `pnpm vitest run test/supervisor`

---

## S15 — Chunked object storage · depends: S9 · DONE

Durable Object SQLite has row and BLOB limits. Storing one complete Git object per row produced raw `SQLITE_TOOBIG` errors above about 2 MB: 1 MiB and 2.5 MiB worked; 4 MiB threw.

Objects are split into chunks beneath the four-function interface. Their address remains the SHA-1 of the complete object, so callers cannot observe the storage layout. `littledivy/durable-git` uses 1 MiB chunks; `@cloudflare/computer` uses 512 KiB.

**Verify:** `pnpm test` (the shared conformance suite covers both stores)

---

## S16 — Capability preflight · depends: S13 · DONE

The Darwin Gödel Machine checks that a candidate can compile and still modify itself before it spends on benchmarks. This implementation checks the four current tools and self-edit path because losing one makes this executor unusable. It does not require every later harness to expose `edit`.

Preflight drives the candidate executor, not a second execution path. As the facet evolves, its declared runtime contract and successor-proposal check must evolve too. It is a viability floor, not an optimization target.

**Verify:** `pnpm vitest run test/validation`

## Deferred and out of scope

**Garbage collection — deferred (ADR-0007).** A Durable Object holds 10 GB and deduplicated module blobs are kilobytes, so storage pressure is distant. A root-discovery bug could delete objects rollback needs, breaking recovery to reclaim space the project does not yet need.

**Excluded from the overnight build, not from the product:** any UI, `patch.md` support, code-server, GitHub webhooks, and the container backend.

**Not built, and worth being honest about:** measuring whether a prompt is better requires live generation against the candidate prompt and scored trials over task invariants. Replay of recorded responses is a different mechanism, so calling it a general compatibility corpus would hide that gap (ADR-0005).
