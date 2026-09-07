# Sol review: the plan from here to v0

Reviewed at `7818f8d5e06a3887bb16662f3fb854c7267687f6`. I read the approved roadmap, both Opus reviews, the task reports, the current source, and the architecture documents in the order required by `docs/agents/domain.md`. I made no paid call. I ran `pnpm harness:browser` only. It failed before starting because `tools/browser-harness/run.mts` does not exist.

## Findings ranked by leverage

### 1. T9 has two race faults at the boundary that awards real-turn credit

**What is true.** The Supervisor can run one generation and credit another if activation happens while mount, provision, or facet startup is pending. It can also start a turn after the start deadline has already abandoned its lease.

**Evidence.** `runProjectTurn` admits the turn at `src/supervisor/projects/turn-run.ts:133-144`, but reads generation attribution only after `boundedStart` returns, at `src/supervisor/projects/turn-run.ts:194-205`. The actual serving generation is read separately during mount at `src/supervisor/supervisor.ts:388-399`. This contradicts the comment that attribution is captured at admission (`src/supervisor/projects/turn-run.ts:103-110`). In addition, `boundedStart` races `input.start` against a timer without cancelling the losing promise (`src/supervisor/projects/turn-run.ts:169-183`). A late `startTurn` starts work immediately in the stream constructor (`src/facet/generation-0/facet-turn.ts:96-126`), after the Supervisor has abandoned the lease at `src/supervisor/projects/turn-run.ts:143-147`. Startup and streaming each receive a fresh full deadline (`src/supervisor/projects/turn-run.ts:169-183`, `:209-219`). The configured four-minute deadline is below a five-minute lease (`src/supervisor/supervisor.ts:85-110`), but the combined path can run for almost eight minutes.

**Cost.** Evidence and completed-real-turn credit can be assigned to the wrong generation. A timed-out start can become a zombie turn and edit the shared workspace beside a replacement turn. A replacement can also take the expired lease around minute five while the old facet continues until minute eight. Lease fencing protects the thread transaction, not project files. This can invalidate criteria 6, 8, and 9 even when local happy-path tests pass.

**What to do.** Make the serving label and preparation check one admission snapshot and use that same value for mount and attempt creation. Give startup an abortable contract, or make a late start result cancel its returned stream before another admission can use the project. Add deterministic tests for activation during startup and for a start that resolves after its timeout. Do this before T11, because T11 must test the corrected contract rather than preserve the current one.

### 2. T10 is merged without its required browser harness, and the advertised command is broken

**What is true.** T10 did not deliver acceptance criteria 6 and 8. The repository advertises a harness that is absent.

**Evidence.** `package.json:21` maps `pnpm harness:browser` to `tools/browser-harness/run.mts`. `AGENTS.md:23-25` says that command drives Chromium and names `tools/browser-harness/README.md`. Neither tracked path exists at `7818f8d`. The T10 commit itself changed no file under `tools/browser-harness/`, while its report still says the harness is “in progress” (`.audit/v0/tasks/T10.md:1-4`, `:135-138`, `:148-151`). My local command failed with `ERR_MODULE_NOT_FOUND` for `tools/browser-harness/run.mts` before opening a browser.

**Cost.** The only objective UI check outside `pnpm verify` is red. The page can ship with broken streaming, keyboard, or viewport behavior while the normal gate stays green. `AGENTS.md` currently makes a false operational promise.

**What to do.** Reopen T10 as T10b. Restore or rebuild the tracked harness, run it, and retain its output. Add a cheap gate assertion that the script and its README exist, while leaving the minute-long browser run outside `pnpm verify`. Do not claim T10 complete until the command passes.

### 3. The merged page silently drops the harness-owned diff

**What is true.** T13 produces `diff` and `diff-unavailable`, but the page ignores both. T14 fixes this on commit `f00eaac`, but that commit is not in `main`.

**Evidence.** The Supervisor's browser union includes both kinds at `src/supervisor/projects/turn-frames.ts:48-77`. The page handles only `text`, `tool-start`, and `tool-result`, then silently returns for every nonterminal kind at `src/page/script-turn.ts:86-109`. The current diff renderer at `src/page/script-render.ts:74-102` only recognizes diff-looking text passed through `renderOutput`; no code sends a `diff` frame there. The unmerged report records the exact two-file fix and explicitly says the browser harness still does not exist (`.audit/v0/tasks/T14.md:1-15`, `:91-98`).

**Cost.** Goal criterion 4 and the recording cannot show the diff that T13 was added to guarantee. The bug also proves that the inline JavaScript has no exhaustive connection to `ProjectTurnFrame`; future frame additions can disappear in the same way.

**What to do.** Review and merge T14 or an equivalent patch into T10b. Replace silent unknown-frame handling with an explicit visible protocol error. Generate or type-check the client frame dispatcher from the server union. The roadmap asked for checked TypeScript (`.audit/v0/roadmap-v0.approved.md:687-690`); the worker's report acknowledges that it kept assembled JavaScript strings instead (`.audit/v0/tasks/T10.md:115-123`). That divergence was not an improvement.

### 4. T11 must not run from the approved dependency list as written

**What is true.** The roadmap says T3b determines bounds that T11 needs, but T11's formal dependencies omit T3b. T11 was dispatched while T8 was still blocked and produced nothing.

**Evidence.** T3b's reason says its observed concurrency answer sets bounds for T9, T11, and T12a (`.audit/v0/roadmap-v0.approved.md:412-416`). T11 requires same-commit concurrent build behavior (`.audit/v0/roadmap-v0.approved.md:737-740`), but lists only T3a, T8, and T9 as dependencies (`:751-754`). T11 also owns cancellation around durable save (`:728-733`), which is exactly where the current terminal/cancel race remains unsettled: `TurnReader.read` selects a terminal result and awaits cancellation in `finally` (`src/supervisor/projects/turn-stream.ts:59-77`), then settlement proceeds without rechecking browser cancellation (`:162-169`).

**Cost.** Dispatching T11 before its producers either wastes a worker, as already happened, or writes tests against assumptions that the paid concurrency probe and race fixes later invalidate.

**What to do.** Add T3b and T10b to T11's dependencies. Fix the T9 admission/start races first. Then dispatch T11 after T3b and T8 have landed. A small local test-only task may prepare fixtures now, but it must not claim the integrated workflow.

### 5. Four settled roadmap choices were not implemented

**What is true.** T2 repeats candidate preparation, T4 still publishes zero model limits, T7 compensates with a second facet-owned context budget, and T5 uses the concurrency revision as the fresh-thread identity. T1a also deferred a free supported-release check as if it required paid validation.

**Evidence.** A repeated submission unconditionally calls `prepareGeneration` (`src/routes/generations.ts:128-156`), although the approved roadmap says an already-known candidate must return current status without implicit re-preparation (`.audit/v0/roadmap-v0.approved.md:915-920`). `ROUTE_MODEL` still says `contextWindow: 0` and `maxTokens: 0` (`src/facet/generation-0/stream-assembler.ts:15-26`), while T7 declares an unrelated 64,000-token budget (`src/facet/generation-0/turn-policy.ts:57-76`) instead of consuming T4 metadata. The thread type calls `revision` its monotonic concurrency version (`src/supervisor/threads/thread.ts:5-16`), and fresh-thread increments that same field (`src/supervisor/threads/store.ts:61-86`), despite the approved choice of a durable thread identity rather than a concurrency version (`.audit/v0/roadmap-v0.approved.md:915-920`). Finally, T1a's report deferred checking for a supported Computer pair (`.audit/v0/tasks/T1a.md:127-133`, `:239-249`), but only validation of a replacement needs paid Computer use.

**Cost.** Duplicate submission can repeat build, cache, and startup work. The guessed compaction budget can exceed the real provider context window. Revision appears to fence ABA correctly, but it collapses two concepts after the plan explicitly separated them. Deferring the supported-release lookup increases the chance that paid work begins on an obsolete pair.

**What to do.** Before T1b, perform the free supported-release lookup and publish the real fixed route limits from primary provider documentation. Remove the separate 64,000-token guess once those limits exist. Make repeated submission read the recorded preparation unless the owner explicitly asks to re-prepare. Either add the decided thread identity or record owner approval for the simpler monotonic-revision design with its invariant tests.

### 6. Q7's seven items are measurements from one build, not the paid plan for six criteria

**What is true.** The list is useful, but “exactly this list and nothing else” is wrong. Items 1 through 6 can mostly be collected from one instrumented clean build. The list omits `gh`, the model stream probe, Loader/capability checks, Access, disconnects, activation, and eviction.

**Evidence.** The seven items are stated at `.audit/v0/questions.md:91-109`, while T1b requires the larger capability, Loader, cold-start, restart, and model path at `.audit/v0/roadmap-v0.approved.md:189-212`. The later Q7 addendum itself adds `gh --version` because the credential flow depends on it (`.audit/v0/questions.md:112-125`). Production invokes `gh auth login` and `gh auth setup-git` at `src/github/credential-commands.ts:56-57`. The goal separately requires real GitHub, a coding turn, disconnect behavior, activation and rollback, and restart or eviction evidence (`.audit/v0/goal.md:9-16`).

**Cost.** The owner could approve the seven checks believing that they retire the paid critical path, then discover that most release evidence still lacks authorization or a named environment. Conversely, treating the seven observations as seven paid jobs would buy redundant container starts.

**What to do.** Ask once for a named non-production environment, a run-wide spend cap, disposable repositories, a prefix-scoped R2 rule, and publication policy. Then execute the smallest useful sequence:

1. In one pinned container session, run `gh --version`, `tar --version`, and a read-only GitHub HTTPS check. Stop on failure.
2. Run the real Workers AI text/tool streaming smoke test. It uses a different binding and cannot be inferred from a Computer build.
3. Run two instrumented clean Computer builds. Those runs jointly measure pnpm bootstrap, registry throughput, wall time, disk, native scripts, and map identity.
4. Continue the same T1b environment through Loader load, ordinary internet, durable file, command, cold start, and restart or eviction.

This is the minimum discovery pass. T3b, T6b, T8, deployed Access/browser checks, and exact-release probes remain separate evidence because they test different properties.

### 7. Two more correctness risks should enter T11

**What is true.** Tool output can be truncated while its frame says it was not, and concurrent repository connection can report a project that another request just removed.

**Evidence.** The exec adapter discards old stdout and stderr while reading, but retains no truncation bit (`src/facet/generation-0/execution-env-exec.ts:70-88`). `TurnFrames` later truncates the already-shortened result and derives `truncated` only from that second operation (`src/facet/generation-0/turn-frames.ts:122-136`). For repository connection, one request stores the row, awaits provisioning, and removes the row on failure (`src/supervisor/projects/project-connections.ts:212-229`). A concurrent request can observe `alreadyConnected`, succeed, and return while the first request then deletes the shared row.

**Cost.** Criterion 4 can show incomplete command output as complete. Criterion 3 can return a successful connection that is absent from the catalog. Both are plausible under the shared Durable Object's normal interleaving at `await` points.

**What to do.** Carry truncation metadata from the exec reader to the frame, and test it with output beyond both limits. Serialize connection of the same repository or recheck the stored row after provisioning before returning success. Put both regressions in T11.

### 8. The model route's claimed parse boundary does not validate tools

**What is true.** `validateRequest` checks messages and total bytes, but not the optional tool definitions. It then casts the request to the closed type and forwards `tools` to Workers AI.

**Evidence.** Validation ends after `validateMessages` at `src/model-route.ts:206-223`. `buildProviderPayload` forwards `request.tools` at `src/model-route.ts:227-231`. Both entry points use an assertion whose comment says every field was checked (`src/model-route.ts:270-293`).

**Cost.** Mutable generation code can send malformed or provider-specific tool definitions across the fixed model and credential boundary. At best that produces opaque provider failures. At worst it expands the authority boundary that T4 claims is narrow.

**What to do.** Validate tool names, descriptions, and JSON-schema values at `validateRequest`, with byte and count limits. Add malformed-tool cases to T11 or a focused T4 follow-up before the paid model probe.

## Roadmap execution

The ten merged task branches did not all follow the approved roadmap; one of them, T13, was added after round 2.

| task | divergence from the approved plan | judgment |
| --- | --- | --- |
| T1a | Split local correctness from paid proof, added the committed clean-build probe, and changed the artifact command to build vendored Pi first. The report correctly limits the result to a local pre-check (`.audit/v0/tasks/T1a.md:56-91`). | Improvement. It closed E1 without pretending to close criterion 7. |
| T2 | Removed the journal and request IDs as planned. It retained direct resubmission, no-op activation, and epoch rejection (`.audit/v0/tasks/T2.md:55-91`). | No material divergence. |
| T5 | Raised from Sonnet to Opus and made the durable thread identity, rather than a concurrency counter, fence completion. This was taken out of worker discretion in the approved revision (`.audit/v0/roadmap-v0.approved.md:915-920`). | Improvement. |
| T3a | Found that owner-only Access already existed, so it widened verified scope and rejected caller-selected tenant fields rather than adding a second policy (`.audit/v0/tasks/T3a.md:57-89`). It coalesced same-commit builds instead of choosing random build directories (`:135-160`). | Improvement. The report corrected the plan's false premise and kept one build identity. |
| T4 | Wrote a small binding-specific SSE adapter after the three vendored helpers did not fit. The real provider event shape remains unverified (`.audit/v0/tasks/T4.md:45-72`, `:101-115`). | Reasonable local improvement, conditional on the paid smoke test. |
| T6a | Added a fake-token automation path and an explicit `tooling-missing` result rather than assuming `gh` exists (`src/supervisor/projects/github-connection.ts:121-140`, `:229-249`). | Improvement. It exposed a cheap paid preflight. |
| T7 | Used Pi's own compaction decision with a declared 64,000-token harness budget because the route reports no context window (`src/facet/generation-0/turn-policy.ts:57-76`). Its first diff solution relied on a prompt and was later replaced. | Compaction was an honest local choice that still needs the forced paid run. The original diff divergence was worse; T13 repaired it. |
| T9 | Needed three attempts and changed the handoff from opaque state to server-held messages. It added saved-turn credit separately from relay eligibility (`.audit/v0/tasks/T9b.md:54-73`, `:78-99`). | The separation was an improvement. The admission, timeout, and cancellation races in findings 1 and 4 mean execution is not complete. |
| T13 | This task was not in the approved roadmap. It moved diff production from model instruction into the harness (`src/facet/generation-0/facet-turn.ts:45-68`). | Necessary improvement found by round 2. It still reports the whole dirty worktree, not a pre-turn delta, and omits untracked files (`src/facet/generation-0/turn-policy.ts:49-54`). For the v0 demo's existing-file edit this limit is acceptable if the demo repository starts clean. |
| T10 | Dispatched from `eb7c575` before T13 landed, kept inline assembled JavaScript instead of checked TypeScript, and merged without the browser harness. Its page therefore omitted T13's new frame kinds. | Regression in execution discipline, not an improvement. T10b is required. |

T11 was also dispatched contrary to its declared T8 dependency and produced no artifact. That divergence bought nothing. T14 was produced as the known page follow-up, but it remains outside `main`.

## Remaining work and dependency order

The remaining path is:

1. **T10b, local.** Merge the T14 behavior, restore and pass the browser harness, and bind the client to the complete frame vocabulary. Nothing paid blocks this. T12a needs a working page and browser test.
2. **T9 race fix, local.** Snapshot one serving generation at admission, cancel late startup, settle the terminal/cancel race, and add focused regressions. T11 must consume this behavior.
3. **Paid-run authorization, owner action.** Record the environment, prefix, cap, disposable repositories, R2 scope, and Q5 publication destination. No paid task can start before it (`.audit/v0/roadmap-v0.approved.md:57-79`).
4. **T1b.** Run the cheap preflights first, then the model probe and the complete build, load, capability, and restart chain. T3b and T6b formally depend on it (`.audit/v0/roadmap-v0.approved.md:216-218`, `:435-437`, `:785-787`). T8 should also consume it because its required missing/corrupt rebuild uses the chain T1b proves (`:581-589`), despite the current weak dependency at `:592-594`.
5. **T3b and T8, in parallel.** T3b records the concurrency fact. T8 applies only the simple prefix-scoped age rule and exercises miss/corruption. Both must land before T11. T6b can run beside them when the owner is available.
6. **T6b, owner-assisted.** Real device authorization, two disposable repositories, private clone, and credential persistence. It waits for T1b and `gh` availability.
7. **T11.** Run the local and paid failure/race matrix after T3b, T8, T9 fixes, and T10b. Include the additional races and truncation faults in this review. Keep its narrow fix authority.
8. **T12a.** Deploy the exact candidate only after T6b, T3b, T8, T10b, and T11. The existing dependency list omits T3b and T6b even though T12a repeats concurrency and credential-persistence checks (`.audit/v0/roadmap-v0.approved.md:808-819`). Add them.
9. **T12b.** Record in a clean disposable repository, write exact-SHA notes, publish only after Q5, and stop.

## Q7: what the seven build items buy

| item | what it buys | separate paid step? |
| --- | --- | --- |
| pnpm bootstrap | Proves the pinned pnpm can be downloaded and run in the image. It is an outright build gate (`docs/agents/design/computer-integration.md:95-98`). | No. Observe it in the first clean build. |
| registry throughput | Proves the real 186-package graph downloads, unlike the old `is-odd` probe (`docs/agents/design/computer-integration.md:103-108`). | No. Time and log the first clean build. |
| cold-build timeout | Replaces the guessed 900-second ceiling with an observed bound (`docs/agents/design/computer-integration.md:116-122`). | No. Measure the same build. |
| disk | Proves the build and store fit, with enough headroom for the chosen concurrency policy. | No. Record `df` before and after the same build. |
| `tar` | Proves the checkout command can extract the archive (`src/harness-build.ts:219-226`). | Yes as a seconds-long fail-fast command. |
| GitHub HTTPS | Proves clone and fetch egress, which npm access does not (`src/harness-build.ts:120`, `:139-140`). | Yes as a read-only fail-fast command. |
| two identical Computer maps | Proves the labeled commit can safely identify its rebuilt module map. The local script explicitly does not prove this (`docs/agents/design/computer-integration.md:130-136`). | Yes. This is the core criterion-7 result. |

The list is close to the smallest set of **measurements for one clean Computer build**. It is not the smallest set of **paid release steps**, and it is incomplete even as a preflight because `gh --version` is absent. The owner should approve a bounded run, not seven isolated jobs.

## Disagreements with the Opus rounds

### Round 1

1. Round 1's B3 remedy was too weak. It allowed a model-selected `bash git diff` test, which proved transport but not production (`.audit/v0/review-opus-round1.md:153-160`). Round 2 later corrected it, and T13 had to add harness-owned production.
2. Round 1 repeated the plan's claim that T3 needed to add owner-only Access. The policy already existed; T3a correctly widened the verified scope instead (`.audit/v0/tasks/T3a.md:57-89`).
3. Round 1's corrected plan still omitted T3b from T11's dependencies even though its own T3b text says T11 needs the result (`.audit/v0/roadmap-v0.approved.md:412-416`, `:751-754`).

I agree with its task splits, paid preconditions, T11 fix authority, human T6b step, file ownership, and refusal to fake paid evidence.

### Round 2

1. “SOUND WITH FIXES” was fair at `0161f91`, but it is not a verdict on `7818f8d`. T10 later merged incomplete and T9's deeper races remain.
2. It said T10 was the only large unblocked task while also requiring a new diff task (`.audit/v0/review-round2.md:135-151`). T13 was itself unblocked, so that sentence was internally inconsistent.
3. Its proposed deterministic diff fixed model cooperation, but not turn attribution. Current T13 reads the whole `git diff HEAD` after any mutating tool starts and takes no pre-turn snapshot (`src/facet/generation-0/facet-turn.ts:43-68`; `src/facet/generation-0/turn-policy.ts:49-54`). Call it the repository's current diff, not a complete delta caused only by this turn.
4. It accepted T9b as merge-ready without finding the admission-attribution split, uncancelled late start, terminal/cancel race, or double deadline described above.

I agree with its correction of the T7 diff test, its classification of the local clean-build script as an E1 guard, and its insistence on merging T9 before building the page.

### Risks both rounds missed

Both rounds missed these risks, now visible in merged code:

- no exhaustive frame contract between the Supervisor union and the inline browser client;
- the missing browser harness can pass `pnpm verify` while its documented command is broken;
- generation attribution is captured after startup rather than at admission;
- the losing startup promise continues after timeout;
- browser cancellation can arrive after a facet terminal frame is selected but before authoritative settlement;
- tool-result truncation metadata can be false;
- concurrent duplicate repository connection can return success for a row another request removes;
- the fixed model route does not validate tool definitions.

Paid platform behavior remains unverified by policy. The exact provider chunk format, real `git` and `gh` behavior, Access, Computer disk and timing, R2 lifecycle, eviction, and credential persistence will be settled only by the Q7 run.

## Standing lessons for `AGENTS.md`

Three lessons belong in `AGENTS.md` because they constrain recurring repository work:

> Write objective checks against required behavior, not a file path, symbol name, or expected implementation.
>
> Merge a producer before dispatching code that consumes its interface. If both run in parallel, record and assign the required integration follow-up before either merge.
>
> `pnpm probe:clean-build` is an E1 regression check. It does not prove reproducible builds. That claim requires two clean Computer builds of the same labeled commit.

I would not add the one-token quota lesson. It describes the current agent provider's quota behavior, not this repository's build or release practice. Keep it in the run record. If the repository continues to dispatch paid model workers as an established process, move it into a dedicated dispatch runbook rather than the main contributor instructions.

## The v0 cut

The product cut still holds. The real edit/check/diff, saved thread, owner-only Access, separate GitHub authorization, commit build/cache/load, manual activation and rollback, restart evidence, and recording all directly prove the boundary described in the seven-step demo (`docs/agents/design/feature-map.md:31-44`). The simple R2 age rule is explicitly in scope (`docs/agents/design/feature-map.md:175-175`). Shared-container concurrency cannot be dropped because goal criterion 9 explicitly requires a recorded outcome (`.audit/v0/goal.md:15-16`).

Keep the remaining tasks narrow. Do not turn T8 into retention software, T3b into a scheduler, T11 into a second implementation project, or the Computer upgrade check into a migration unless the pinned pair is unavailable. The current extra work that belongs before release is limited to the correctness repairs in findings 1 through 3 and the small honesty fixes in finding 6. Everything else named by the goal should stay. The postponed features in the cut line should remain postponed (`.audit/v0/goal.md:18-20`).

THE PLAN HOLDS WITH FIXES — next three dispatches: T10b browser-and-diff completion; T9 admission/start/cancel race repair; T1b paid preflight, build, load, and model probe after the owner answers Q7.
