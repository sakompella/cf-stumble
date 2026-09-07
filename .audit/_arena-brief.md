# Open-gap arena brief

## startup-check

### Recommended design

Use an immutable Supervisor Durable Object to create a candidate-only main facet, then send one synthetic ordinary `fetch(Request)`. Drain the bounded response body under the same elapsed decision deadline used for header arrival. Record the result and move the active-generation pointer only after the response predicate accepts it. The probe request must be idempotent and must avoid provider calls, tools, session mutation, and other effects; it is startup evidence only, not a completed streamed real turn or known-good evidence.

The prototype's state and policy shapes are:

- `CheckResult`: `method` (`"lazy-mount"` or `"synthetic-fetch"`), `candidate`, `outcome` (`"mounted"`, `"ready"`, or `"rejected"`), optional `stage` (`"setup"`, `"request"`, `"response"`, `"body"`, or `"timeout"`), optional `detail`, `elapsedMs`, and `activeAfter`.
- `Candidate`: `source` and `exportName`.
- `StartupPolicy`: `request`, `deadlineMs`, `maxBodyBytes`, and `accepts(response, body)`. The fixture uses `GET https://main-facet.invalid/`, `deadlineMs: 25`, `maxBodyBytes: 64`, and accepts only status `200` with body `"ready"`.
- SQLite tables `generation_pointer (id INTEGER PRIMARY KEY, name TEXT NOT NULL)` and `startup_results (id INTEGER PRIMARY KEY AUTOINCREMENT, candidate TEXT NOT NULL, method TEXT NOT NULL, outcome TEXT NOT NULL, stage TEXT, detail TEXT, active_after TEXT NOT NULL)`.

`makeCandidateFacet` must be inside the guarded probe path. It validates `exportName`, calls `ctx.facets.abort(facetName, "discard prior candidate probe before remount")` on the candidate name only, gets a Worker Loader entry, calls `worker.getDurableObjectClass`, and calls `ctx.facets.get`. Candidate facet names are based on the generation number and artifact identity, not the active facet identity. On success, `record` is called only after `UPDATE generation_pointer SET name = ? WHERE id = 1`; failures leave the pointer untouched. `readBodyLimited` reads until EOF, cancels when `total > maxBytes`, checks declared `content-length`, and releases the reader lock.

### Failure cases to reuse as tests

- Malformed metadata: `bad-metadata` produces `setup`, detail `candidate is missing Durable Object export metadata`.
- Module parse failure: `parse` produces `request`.
- Missing Durable Object export: `missing-export` produces `request`.
- Constructor throw: `constructor` throws `constructor exploded` and produces `request`.
- First request throw: `first-request` throws `first request exploded` and produces `request`.
- Delayed headers/request: `slow` exceeds the deadline and produces `timeout`.
- Rejected response: `unacceptable-response` returns `503` and produces `response`.
- Declared-length mismatch: `truncated-body` declares length `6` but supplies `5`, producing `body`.
- Body over limit: `oversized-body` exceeds `64` bytes, producing `body`.
- Delayed body: `slow-body` delays its second chunk and produces `timeout`.
- All failed probes preserve a non-stable pointer, tested as `active-v42`; only `success` changes it to `success`.

### Evidence status

**Proved locally in workerd/Vitest:** real Worker Loader use, Dynamic Worker Durable Object class lookup, `ctx.facets.get`, `ctx.facets.abort`, ordinary `facet.fetch`, guarded constructor and first-request failures, result recording, stage classification, bounded body and declared-length checks, timeout handling for delayed request/body, and active-pointer preservation. Typecheck and one Vitest test passed.

**Proved by a paid deployment:** nothing. No Cloudflare resource was deployed for this synthesis.

**Unproved:** `abort()` cancellation of an in-flight request; production cold starts, loader cache reuse, hibernation, restart, stub invalidation, facet limits, module-map size, global-startup and memory limits, caller-visible deadlines, concurrent Dynamic Worker limits, live routing to an already-active non-stable facet during candidate failure, and genuine mid-body stream errors. The first `controller.error()` fixture caused an unhandled remote rejection, so only declared-length truncation was retained locally.

### ADR contradictions

The recommendation explicitly retains an `artifact/runtime digest` in the generation record and names candidate facets from `generation number and artifact digest`. That conflicts with human-approved ADR-0027, **Use the labeled harness commit as Worker Loader identity**, which says the commit ID is the Loader identity and says, “Do not add a separate artifact digest or mount key.” The recommendation also treats the generation record as separate from the labeled commit identity; ADR-0002 defines a generation as one specific labeled harness commit, with failed checks recorded as events on that commit.

## generation-control

### Recommended design

Keep candidate 2's measured platform boundary: an isolated Dynamic Worker facet, ordinary whole-origin `fetch` forwarding, a separate authenticated control hostname, a service-binding entrypoint, and a narrow generation-scoped `RpcTarget` introduced as an RPC argument. Do not put `RpcTarget`, a function, `WorkerLoader`, or a broad supervisor stub in Dynamic Worker loader `env`; local workerd reported `DataCloneError` for those forms. Keep `attachControl` optional; a facet without it remains runnable but has no control authority.

Expose only `create-candidate(sourceRef)`, `activate(target, observedEpoch)`, and `rollback(target, observedEpoch)`. The synthesized model uses `Generation` numbers, `Epoch`, `Principal` (`user` or `harness` with a generation), an `Envelope { requestId, command }`, and outcomes `pending`, `accepted`, or `rejected`. A `GenerationRow` has `number`, `sourceRef`, `status` (`preparing`, `ready`, `failed`), `knownGood`, and `everActive`. `PendingOperation` has `phase` (`prepare` or `switch`), `generation`, `command`, and `previous`. `JournalEntry` has `fingerprint`, `pending`, and `outcome`. State has `epoch`, `nextGeneration`, `active`, `generations`, `journal`, and `activationEvents`.

In production, reservation/activation reservation, pending work, registry state, and idempotency journal must be committed by one synchronous SQLite transaction. A retry with the same request ID and fingerprint returns the pending record or terminal outcome; reuse with a different fingerprint returns `request-id-reused`. Record terminal rejections as well as acceptances. `submit` reserves preparation or switching work, and immutable startup/recovery code calls `settle(principal, requestId, succeeded)` after cold preparation or facet replacement. A restart enumerates `recoverable()` pending rows before accepting conflicting work. `markKnownGood` requires a ready generation and increments the epoch.

Validate harness authority before command processing: a harness whose generation is not `state.active` receives `revoked-capability`. For activation/rollback, require the caller's `observedEpoch` to equal the current epoch, require an existing `ready` target, and require `knownGood` for rollback. An already-active target is an accepted, journaled `no-op`. Increment the epoch for protected-state changes, including preparation completion and known-good evidence. Do not expose `quarantineGeneration`, `diagnose`, or `probeCapabilityTransports` on the public Supervisor class.

### Failure cases to reuse as tests

- Candidate 1 does not typecheck: missing `better-result` and `./control/channel.js`, plus implicit-`any` errors.
- Candidate 1 has no test files; candidate 2's loader-env `RpcTarget` attempt fails with `DataCloneError: Remote RPC references can only be serialized for RPC`.
- Passing a function in loader `env` fails with a DataCloneError; passing `WorkerLoader` fails with `DataCloneError: Could not serialize object of type "WorkerLoader"`.
- A leaked or stale harness capability must return `revoked-capability` after activation changes the active generation.
- A stale `observedEpoch` must return `stale-epoch`.
- An unknown target must return `unknown-target`.
- A target not in `ready` status must return `not-ready`.
- Rollback of a target without known-good evidence must return `not-known-good`.
- Reusing a request ID with a different command fingerprint must return `request-id-reused`.
- Failed preparation/activation settlement must produce `work-failed` and terminally record the operation.
- A missing journal entry must raise `unknown operation`; a corrupt entry with neither pending nor outcome must raise `journal entry has neither outcome nor operation`.
- Duplicate concurrent activation with the same request ID must share one pending operation and append one activation event.
- A failed transaction must publish neither the generation reservation nor the journal entry; the model injects `simulated crash before commit`.
- Already-active activation must be `accepted` with effect `no-op`.

### Evidence status

**Proved locally in workerd/plain deterministic tests:** candidate 2's workerd tests passed 31 checks covering isolated facet storage, narrow RPC-argument capability introduction, duplicated stub behavior, capability loss after generation change, whole-origin harness forwarding, separate control hostname, and service-binding routing. The same run observed the three loader-env serialization errors. The synthesized dependency-free TypeScript model passed 5/5 checks for restart-visible pending work, atomic draft commit, duplicate activation, stale capability rejection, no-op activation, and known-good rollback.

**Proved by a paid deployment:** nothing. The synthesis explicitly says no deployment was performed.

**Unproved:** actual Durable Object crash recovery and SQLite transaction atomicity, paid-runtime RPC introduction and `dup()` lifetime, post-replacement stale stubs, browser authentication/CSRF, control route behavior after deployment, and interleavings around reservation, completion, settlement, and journal replacement. The synthesized transaction is an in-memory model, not Cloudflare persistence evidence.

### ADR contradictions

The synthesized model allocates `nextGeneration` numbers from `sourceRef` and describes a generation as a preparation/activation record. ADR-0002 says a generation is one specific, labeled harness Git commit, and that a failed check is an event on that labeled commit, not a different generation. `sourceRef` must therefore not replace the labeled commit identity. The recommendation also needs to use the labeled commit as Loader identity under ADR-0027; it must not introduce a separate artifact digest or mount key.

## known-good

### Recommended design

Use an epoch-bound durable evidence ledger. Qualification is a derived Supervisor Durable Object query over durable observations, not a mutable `lastKnownGood` pointer. A generation requires a successful cold probe and either policy-qualified real-turn evidence or trusted user approval. It is not qualified merely because it is active, Generation 0, or returned an HTTP success.

The synthesized `EvidenceLedger` registers each generation with `generation`, `probeEra`, `probePassed`, `failurePending`, `acceptedCompletions`, `approval`, and `automaticQualifiedAt`. `recordColdProbePass` increments `probeEra`, clears failure/evidence/approval, and starts a new evidence era. `activate` requires a passed probe and no pending failure and returns `{ generation, epoch }`. Each terminal observation contains `generation`, `activationEpoch`, `turnId`, `outcome` (`completed`, `generation-failed`, or `unresolved`), and `at`.

Production observations use a durable unique key `(generation, activation_epoch, turn_id)` and store event ID, observed time, outcome, policy version, and disposition. Insert and evidence-state update happen in one SQLite transaction. Duplicate delivery is a no-op. A report from a replaced activation is retained as `stale` audit data and earns no credit. Automatic qualification requires both `minimumCompletedTurns` distinct completions and `minimumObservationSpanMs` between the first and qualifying completion; the fixture uses `3` and `60_000`. `generation-failed` immediately clears automatic evidence and approval; a new successful cold probe is required before evidence or approval can qualify the generation again. `unresolved` earns neither credit nor blame. Trusted approval stores actor, reason, time, evidence-era ID, and policy version, and also requires the fresh-probe gate. Recovery computes eligible generations at selection time and leaves ranking to recovery-bounds.

### Failure cases to reuse as tests

- A burst of three completions at `0`, `1_000`, and `2_000` remains probationary; a fourth at `60_000` qualifies it.
- Reusing the same `(generation, activationEpoch, turnId)` after a different outcome returns `duplicate` and cannot double-credit.
- A completion from an old activation epoch is retained with disposition `stale` and is not credited.
- A `generation-failed` observation returns `failure-revoked`, clears evidence and approval, and makes the generation ineligible.
- Approval before a fresh post-failure cold probe raises an error matching `cold probe`.
- `unresolved` returns `unresolved`, earns no completion credit, and does not set `failurePending`.
- Sparse traffic remains probationary even with the required count if the observation span is too short.
- After current-generation revocation, the eligible target is derived from durable records and can fall back to an older user-approved generation.
- Cold-probe pass on an unknown generation raises `unknown generation`; duplicate registration raises `generation ... already exists`.
- Unknown terminal outcomes raise `unknown outcome`; approval without actor/reason raises `approval needs an authenticated actor` or `approval needs a reason`.
- Cold-probe pass or activation is required before evidence can qualify a generation.

### Evidence status

**Proved locally in deterministic tests:** the pure Node prototype passed 6/6 checks for time-and-count qualification, unique identity, stale reports, failure revocation and fresh-probe approval, unresolved delivery, sparse traffic, and derived target selection. It exercised no workerd or Cloudflare boundary.

**Proved by a paid deployment:** nothing. No paid deployment occurred.

**Unproved:** Durable Object SQLite uniqueness/transactions through hibernation or restart, Dynamic Worker replacement epochs, observer authority, real stream outcome classification, trusted user identity, and values for the time/count policy. The prototype values are fixtures only.

### ADR contradictions

The recommendation's statement that “a generation is a numbered preparation attempt, separate from a Git commit” directly contradicts human-approved ADR-0002, which defines the generation as a labeled harness commit. Its ledger key must use the labeled commit generation identity, and Loader identity must follow ADR-0027 without a separate digest or mount key. The recommendation otherwise preserves ADR-0003's Supervisor ownership and ADR-0024's mutable-facet boundary.

## real-turn

### Recommended design

Use candidate 3's manual Supervisor relay. The Supervisor receives and forwards the ordinary request unchanged to the active main facet, preserving method, URL, headers, and body. It records upstream facts without requiring a health endpoint or mutable turn protocol. Add separate logical-turn and delivery-attempt records, acknowledgement storage, a durable deadline, and an alarm-based expiry path.

The prototype creates SQLite tables `logical_turns (turn_key TEXT PRIMARY KEY, evidence_attempt_id INTEGER)` and `delivery_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_key TEXT NOT NULL UNIQUE, logical_turn_key TEXT NOT NULL, status INTEGER, outcome TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, deadline_ms INTEGER NOT NULL, FOREIGN KEY(logical_turn_key) REFERENCES logical_turns(turn_key))`, plus `attempts_by_logical_turn`.

Require valid `x-cf-stumble-attempt-id` and `x-cf-stumble-logical-turn-id` headers. `reserveAttempt` runs in `transactionSync` before any `await`: duplicate attempt keys return `duplicate-attempt`; a pending latest attempt returns `logical-turn-pending`; a settled turn requires `x-cf-stumble-safe-resume: true`, otherwise `safe-resume-required`. A reserved attempt gets `deadlineMs = Date.now() + 5 * 60 * 1_000` and is dispatched with `this.facet().fetch(request)`. On pre-header throw, finish `facet-body-error` with `status: null` and return `502`. For a body, the manual `ReadableStream` relay records `facet-body-complete` at EOF, `facet-body-error` on reader failure, and `relay-cancelled` on outer cancellation. `finish` updates only rows still `pending`; a completed 2xx body sets `logical_turns.evidence_attempt_id` only when it is null. `acknowledge` is allowed only for `facet-body-complete`; it sets `acknowledged = 1`.

The outcome set is `pending`, `facet-body-complete`, `facet-body-error`, `relay-cancelled`, and `bounded-abandonment`. A completed 2xx body is eligible for one server-execution evidence credit. Completed 4xx is neutral by default; completed 5xx and pre-header/body errors are failure observations. Acknowledgement is delivery telemetry, not completion proof. An alarm calls `expireDue(Date.now())`; pending attempts at or past `deadline_ms` become `bounded-abandonment`. Safe resume must be explicit and does not prove replay safety for model/provider/tool/workspace/Git effects.

### Failure cases to reuse as tests

- Missing or invalid attempt/logical-turn headers returns `400` with `x-cf-stumble-attempt-id and x-cf-stumble-logical-turn-id are required`.
- `/echo?mode=full` with `POST`, body `request-body`, and `x-pass-through: preserved` must arrive unchanged.
- `/pre-header-error` throws `facet failed before headers`, returns `502`, and records `facet-body-error` with null status.
- `/midstream-error` emits `partial` and then fails with `model stream failed`; status `200` must not become success.
- Complete `400` and `500` bodies record `facet-body-complete` but have `ineligible-status`, not evidence eligibility.
- Outer reader cancellation records `relay-cancelled` or leaves the operation pending until alarm expiry; it must not infer success or failure of committed effects.
- `/effect-and-hang` commits one facet-local `effects` row while delivery remains open; the attempt stays pending until `bounded-abandonment`.
- A second attempt for a pending logical turn returns `409` `logical-turn-pending`.
- Reusing an attempt key returns `409` `duplicate-attempt`.
- A settled logical turn without safe resume returns `409` `safe-resume-required`.
- Safe resume may complete but its attempt has `no-credit` because `evidence_attempt_id` already belongs to the first attempt.
- Acknowledging an incomplete response returns `409` `cannot acknowledge an incomplete facet response`; acknowledging an unknown row returns `404`.
- Delayed stream, disconnect, alarm, and duplicate attempt behavior remain explicit deployment cases.

### Evidence status

**Proved locally in workerd/Vitest:** one test file passed 5/5. The prototype proved intact ordinary request forwarding, streaming relay bytes, pre-header throws, post-header body errors, terminal 400/500 observations, durable attempt reservation before dispatch, duplicate/pending blocking, one logical-turn evidence contribution, acknowledgement, test sweep expiry, and committed facet-local effect remaining observable while delivery is unresolved. Local workerd emitted uncaught diagnostics for stream errors; rows still reached expected terminal states, so clean production error reporting is not established.

**Proved by a paid deployment:** nothing. No deployment or Cloudflare resource was used.

**Unproved:** edge disconnect propagation to Supervisor/facet, browser delivery and acknowledgement reliability, alarm survival through hibernation/runtime updates, stream buffering/cost, real effect idempotency, provider/tool/workspace/Git replay safety, and production timing/memory/active-duration limits.

### ADR contradictions

The prototype uses `ARTIFACT_ID = "real-turn-synthesis-v1"` as a Worker Loader key. If production retains a separate artifact ID rather than the labeled harness commit ID, that conflicts with ADR-0027's prohibition on a separate artifact digest or mount key. The ordinary-fetch boundary is consistent with ADR-0003's tested option, while the recommendation correctly leaves detailed recovery policy open.

## recovery-bounds

### Recommended design

Use the Supervisor Durable Object for an immediately applied fallback and separately checkpointed repair and cold-probe stages. In the transaction that deduplicates a failure event, snapshot a validated policy, allocate an absolute recovery deadline, and route to a retained known-good generation. The fallback must exist, differ from the failed generation, and have an eligible retained artifact. If absent or equal to the failed generation, set `phase: "blocked"`, `result: "blocked:no-known-good-generation"`, and no active route; do not silently use Generation 0 or a null-like sentinel.

The recovery report contains `id`, `failureEventId`, `failedGeneration`, `fallbackGeneration`, immutable `policy`, `startedAt`, `recoveryDeadlineAt`, `attemptsUsed`, `phase`, `currentOperation`, `candidateGeneration`, `result`, and `errors`. Policy fields are positive safe integers: `maxRepairAttempts`, `recoveryBudgetMs`, and `operationDeadlineMs`; `operationDeadlineMs` must not exceed `recoveryBudgetMs`. Before every remote action, persist an operation with `kind` (`repair` or `probe`), attempt, candidate generation, key, `deadlineAt`, and reconciliation field. The keys are distinct, such as `recovery-1:repair:1` and `recovery-1:probe:1`.

`resume(recoveryId)` performs one transition only. It replays a still-valid pending operation with the same key, starts repair until the attempt budget or absolute report budget is exhausted, then starts a separate cold probe. A repair success records `candidate-ready` only after the probe succeeds; it never automatically replaces the known-good route. Failed repairs consume attempts; exhaustion yields `fallback-retained:repair-attempt-budget-exhausted` or `fallback-retained:recovery-budget-exhausted`. An operation that times out or is cancelled becomes `needs-reconciliation` or `cancelled-needs-reconciliation`; keep its key and do not issue a replacement effect under a new key. `reconcile(recoveryId, key, result)` applies only to the current operation and may advance a late repair success to the separate probe while still within the report deadline. Cancellation never resumes automatic work. Duplicate failure triggers return the original recovery record.

### Failure cases to reuse as tests

- Fallback must route before repair/probe; after successful repair and probe, route remains on `generation-7`.
- Duplicate `failureEventId` returns the original recovery record rather than creating another episode.
- A crash after a remote repair effect must replay `recovery-1:repair:1`, not issue a fresh key; effect count remains one.
- `maxRepairAttempts: 0` raises `maxRepairAttempts must be a positive safe integer`.
- `operationDeadlineMs > recoveryBudgetMs` raises `operationDeadlineMs cannot exceed recoveryBudgetMs`.
- Repeated `bad-instructions` repair failures exhaust the attempt budget and produce `fallback-retained:repair-attempt-budget-exhausted`.
- A pending operation at its deadline becomes `needs-reconciliation` with `operation-deadline-exceeded`, retains its original key, and does not execute again automatically.
- Late successful reconciliation of a repair starts only the separate probe.
- Cancellation with a pending repair produces `cancelled-needs-reconciliation`; later `resume` and reconciliation do not start automatic work.
- Reconciliation with a mismatched key returns `applied: false`.
- A report at its absolute deadline produces `fallback-retained:recovery-budget-exhausted` without a capability call.
- Missing fallback (`null` or `undefined`) produces `blocked:no-known-good-generation` and clears the route.
- Using the failed generation as fallback is also blocked.
- Unknown recovery IDs raise `unknown recovery: <id>`.

### Evidence status

**Proved locally in deterministic tests:** syntax checks passed and the pure Node state machine passed 8/8. It proved fallback-before-repair, deduplicated triggers, same-key crash replay, immutable policy snapshots, attempt and absolute-budget bounds, retained pending keys, late reconciliation, cancellation behavior, and absent/failed fallback blocking.

**Proved by a paid deployment:** nothing. No deployment ran.

**Unproved:** real Supervisor SQLite/checkpoint transactions across eviction, alarm scheduling and delivery, concurrent authenticated resumes, retained-artifact materialization, Worker Loader/facet cold starts, capability idempotency/cancellation/reconciliation, remote-effect commit timing, and whether application deadlines contain remote work rather than only stopping the wait. The no-known-good blocker is product policy, not platform evidence.

### ADR contradictions

The recovery model treats `failedGeneration` and fallback generation as opaque generation IDs, while ADR-0002 requires those IDs to denote labeled harness commits and treats failed checks as events on that commit. Any recovery artifact or mount identity must also use the labeled commit under ADR-0027; the prototype's operation keys are recovery operation identities, not Loader identities, but they must not be turned into a separate artifact digest or mount key.
