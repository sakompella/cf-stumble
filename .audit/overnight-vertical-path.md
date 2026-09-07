# Overnight run: local vertical path for the supervisor

Playbook: **figure-it-out** (large, multi-part, reviewed after the user steps away), driven under **Autonomous run** discipline. Decision trail: `.audit/overnight-vertical-path.tsv` via **show-me-your-work**.

Source documents, in reading order: `docs/agents/design/overview.md`, `docs/agents/CONTEXT.md`, `docs/agents/adr/README.md` and the five human-approved ADRs, `docs/agents/design/slices.md`, `docs/agents/design/computer-integration.md`, `docs/agents/_open-gap-arenas.md` (evidence, not decisions).

## Phase A: Frame

- **Predicate.** Local workerd tests prove, one unit at a time: a content-addressed module-map artifact mounted under the labeled harness commit ID; supervisor-owned generation state that a facet cannot write; a bounded startup check that leaves the active generation intact when a candidate fails; validated candidate, activation and rollback requests that survive retries; raw real-turn observation facts that make headers-alone insufficient; and a bounded recovery policy that returns to a retained eligible generation. Every landed unit ends with `pnpm verify` green, one commit, and its settled choice recorded as an ADR or logged as still open.
- **Scope.** Six units, sequential, all inside `src/` and `test/` plus `docs/agents/adr/`. Slices 3, 5, 6 and 7 of `slices.md` (Computer workspace, real conversation, real recovery failures, UI) need paid deployment, a model provider, or a Pi fork, so they are out of scope tonight.
- **Rigor.** High. Generation identity, the supervisor-to-facet boundary and the authority split are one-way doors that every later slice depends on. Each unit lands only behind a green `pnpm verify` and a diff the coordinator read.
- **Blockers surfaced.** The paid account is authenticated with workers-write scope, but no deploy runs tonight: deploys are an always-pause action and `slices.md` orders local proof first. Arena artifacts under `/tmp/cf-stumble-open-gaps/` are the only copy of the paid-account evidence and `/tmp` is not durable.

## Phase B: Designed unit sequence

Riskiest-unknown-first. Each unit is one experiment, one commit, one verified predicate. Implementation delegated per unit to `openai-codex/gpt-5.6-terra`; the coordinator reads every diff, runs verify itself, and commits. Cross-family review (`anthropic/claude-opus-5` or `claude-sonnet-5`) on the units that set a boundary.

- **U1. Module artifact.** Replace the inline fixture in `src/agent/loader.ts` with a typed module-map artifact, one bundle expressed as a one-module map. Loader identity is the labeled harness commit ID and nothing else: ADR-0027 is human-approved and says in as many words not to add an artifact digest or mount key, which overrides the content-addressed proposal in `_open-gap-arenas.md`. Structural validation still happens before the Loader callback, on the artifact's invariants rather than on a hash. Tests: multi-module load, one-module bundle load through the same path, two labeled commits get different Loader names and each runs its own code, and an artifact whose entry module is missing from the map is rejected before mount.
- **U2. Generation state.** Supervisor SQLite owns generations, activation epoch and evidence rows (ADR-0003). Branded `HarnessCommit` and `GenerationLabel`, illegal states unrepresentable. Tests: transitions, and no facet-reachable write path into protected state.
- **U3. Startup check.** Mount a candidate-only facet, send one bounded ordinary request, drain a bounded body, record the result against the generation, no permanent health method. Tests: syntax error, missing class, constructor throw, error response, timeout bound; the active generation survives every failure.
- **U4. Generation control.** Authenticated control adapter for candidate submission, activation and rollback. Persist the pending operation and its idempotency result before awaiting work. Tests: retry is idempotent, stale generation capability rejected, requester cannot write protected state directly.
- **U5. Real-turn facts.** Record pre-header failure, headers, body completion, body failure, relay cancellation and bounded abandonment as separate raw facts bound to the activation epoch. Known-good eligibility derives from the facts through versioned policy. Tests: deterministic policy over synthetic fact sequences; headers alone earn no credit; bounded abandonment earns neither success nor failure.
- **U6. Recovery bounds.** Prefer a retained eligible fallback, then bounded repair and startup-check stages under attempt, episode and operation limits, reconciling ambiguous timeouts under the original key, ending in a recovery report. Deterministic tests.

Each unit that settles one of the ten open questions in `overview.md` gets an ADR in the agent-only section of `docs/agents/adr/README.md`, citing the arena evidence and naming what stays unproved. A unit whose evidence does not support a decision logs the choice as still open instead.

## Phase C: Loop discipline

State the hypothesis, make the smallest change, run `pnpm verify` against the real artifact, keep it if it advanced, revert it if it did not. Verify by reading the diff and the test output, never a delegate's self-report. A verdict is VERIFIED, NOT VERIFIED or INCONCLUSIVE; inconclusive is not a pass. Mid-run discoveries (flaky verifier, tooling failure, drift) are fixed in their own commit, then the run returns to the predicate.

## Phase D: Trail

One row per unit and per fork in `.audit/overnight-vertical-path.tsv`. Local only, `.audit/` is gitignored.

## Phase E: Hand back

Re-run `pnpm verify` on the final tree, audit the log against what actually happened, then a cross-family reviewer reads the trail and flags what deserves scrutiny. Reply names the predicate state, what landed, what was discarded and what is still open.

## Status

- [x] U1 module artifact. `fe8ca75` code, `e321a01` ADR-0028. `pnpm verify` green, 10 tests.
- [x] U2 generation state. `76d6231`. `pnpm verify` green, 18 tests.
- [x] U3 startup check. `09d3958`, ADR-0029. `pnpm verify` green, 30 tests.
- [x] U4 generation control. `HEAD`, ADR-0030. `pnpm verify` green, 40 tests.
- [x] U5 real-turn facts. `6641c5c`, ADR-0031. `pnpm verify` green, 50 tests.
- [x] U6 recovery bounds. `2c90d69`, ADR-0032. `pnpm verify` green, 63 tests.
- [x] E: final verify, log audit, and cross-family review. Follow-up review fixes through `cf20dd4`; `pnpm verify` green, 124 tests.
