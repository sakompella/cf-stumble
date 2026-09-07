# Active-generation serving

## Figure it out

### Phase A. Frame

- [x] Define done as a falsifiable predicate.
- [x] Scope the work, the likely files, and blockers before implementation.
- [x] Set high rigor because activation changes user-visible serving and durable state.

Done means public Durable Object tests prove that activation changes normal response bytes to the selected retained artifact, preserves the current serving artifact after a failed activation, and restores the same active artifact after eviction. `pnpm verify` must pass. The work stays local. No deployment, provider calls, dependency changes, README edits, or changes to human-approved ADR authority are allowed.

### Phase B. Design the workflow

- [x] Build the verification harness and capture its current fixture-serving behavior.
- [x] Run `how` over artifact loading, Supervisor activation, and Durable Object reload.
- [x] Run Architect and Arena with isolated candidates. Claude Opus supplied the selected base. The first broad Arena round is recorded as dropouts.
- [x] Write the chosen type and module sketch before implementation.
- [x] Define the delivery units after the design resolves the artifact-retention boundary.

### Feature throughput checkpoint

- [x] Blocking first steps. Read the domain records and capture a local behavior baseline before any writer starts.
- [x] Independent workstreams. Design candidates are independent and use separate worktrees. Implementation uses one owner because the Supervisor, loader, and tests share the same durable-state contract.
- [x] Shared mutable state. Arena candidates receive separate worktrees. The canonical branch changes only after a chosen design passes review.
- [x] Smallest safe decomposition. One implementation owner prevents competing edits to the artifact type, storage, and Supervisor wiring. A separate reviewer verifies the exact resulting commit.

### Phase C. Run the loop

- [x] State a hypothesis for each unit.
- [x] Make one small change.
- [x] Run the focused workerd proof.
- [x] Keep only VERIFIED units. The initial constructor-bound implementation was rejected. Treat INCONCLUSIVE as blocked.

### Phase D. Keep the audit trail

- [x] Create `.audit/active-generation-serving.tsv`.
- [x] Append a row for every design decision and verified unit.
- [x] Audit the trail against commits, diffs, and test output before handoff. Transcript unavailable. The Claude trail review produced corrections that later rows supersede.

### Phase E. Verify and hand back

Completion checklist:

- [x] A ready generation retains the exact checked module map under its labeled harness commit.
- [x] `Supervisor.fetch()` loads and forwards to the active generation’s retained artifact.
- [x] An activation changes observable response bytes.
- [x] A failed startup check cannot replace the currently serving artifact.
- [x] Durable Object eviction reloads the same active artifact and response bytes.
- [x] The Worker Loader name remains the labeled harness commit with no second identity.
- [x] The immutable recovery harness, generation-control epoch scope, relay attempts, and recovery behavior remain unchanged except for correct active-generation attribution.
- [x] Tests use public Durable Object methods and ordinary `fetch`, rather than private mutable state.
- [x] `pnpm verify` passes.
- [x] The completion audit maps every objective constraint to source, test, or command evidence.

- [x] Run the full objective checklist against real code and tests.
- [x] Run `pnpm verify`.
- [x] Run an independent clean-worktree review of the exact candidate SHA.
- [x] Run the required cross-model review of the audit trail.
- [x] Record open platform or product decisions without guessing.

## Completion audit

| Objective requirement | Evidence |
| --- | --- |
| Retain the active generation's harness artifact | `src/supervisor/harness-artifacts.ts` stores the module map under `harness_commit`. |
| Serve the active artifact on normal traffic | `HarnessArtifacts.mount()` resolves the active generation in `Supervisor.fetch()`. |
| Activation changes response bytes | `test/supervisor/active-serving.test.ts` proves the candidate body after activation. |
| Failed candidates preserve traffic | The same test checks a rejected activation and the existing active response body. |
| Eviction reloads the artifact | The same test evicts the Durable Object and reads the candidate body again. |
| Preserve Loader identity and authority boundaries | ADR-0027, ADR-0028, ADR-0033, `src/agent/loader.ts`, and the full relay, recovery, and epoch test suites. |
| Full local gate | Local `pnpm verify` and the independent clean-worktree `pnpm verify` both passed with 138 tests. |
| No forbidden work | The commit range contains no dependency, README, deployment, provider, push, or remote changes. |

## Architect

1. Ground.
2. Sketch.
3. Agree. Skip. The user requested autonomous work.
4. Implement.
5. Scrap if repeated implementation friction disproves the chosen design.

## Arena

1. Frame.
2. Fan out.
3. Cross-judge.
4. Pick.
5. Graft.
6. Verify.
