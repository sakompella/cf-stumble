# T9b — Own the saved streamed turn in the Supervisor

- **Task id:** T9 (worktree T9b, branch `work/T9b`, based on `0161f912`).
- **Commits:**
  - `c3ac884` — `refactor(workspace): delete the unreachable legacy execution path`
  - `4f47fc3` — `feat(supervisor): own the saved streamed turn behind one turn route`
- **Gate:** `pnpm verify` passes at `4f47fc3`: 116 test files, 829 tests.
- **Clean-build probe:** `scripts/probe/clean-build.sh` at `4f47fc3` built the commit twice in
  isolated homes and produced identical module maps.
  sha256 `313ddf26f4492180326ded330d7f6ab49c692eb28a6764261511ecd9cf7897d0` (940347 bytes, 13 s and
  12 s, 491M build directory, 598M cold store). The baseline sha `18cea22b...` belonged to the base
  commit; this commit changes `src/`, so the map changes with it. What the probe holds is that two
  clean builds of the same commit agree.
- **Not run:** no `wrangler deploy`, no Computer workspace, no billing API, no owner credential.

## What each commit does

`c3ac884` applies T7's audited deletion list
(`docs/agents/design/legacy-workspace-execute-deletions.md`), re-checked against this checkout:
`WorkspaceHost.execute` and its fixed `CONFIGURATION`, `parseWorkspaceRequest`,
`planWorkspaceRequest`, `WorkspaceRequest`, `WorkspaceConfiguration`, `executeWorkspaceRequest`, the
`list-files` and `git-diff` plan and result kinds, `listFiles` on `WorkspaceOperations` and
`ComputerWorkspaceOperations`, the re-exports, and the tests that only exercised them. `build`,
`provision`, `project`, and `credential` survive, and so do `executeHarnessBuildRequest`,
`executeProjectProvisionRequest`, `WorkspacePlan`, `WorkspaceResult`, and `WorkspaceFailure`.
`ProjectRpcTarget.listFiles` is a different surface and is untouched.

`4f47fc3` adds the turn route, the Supervisor-side join, the frame parse boundary, the settlement,
the completed-real-turn ledger, and the second eligibility predicate.

## Changed paths

Source: `src/routes/turns.ts` (new), `src/routes/owner-api.ts`, `src/routes/index.ts`,
`src/routes/json.ts`, `src/supervisor/supervisor.ts`, `src/supervisor/eligibility.ts`,
`src/supervisor/relay/attempts.ts`, `src/supervisor/projects/index.ts`, and the new
`src/supervisor/projects/{turn-run,turn-stream,turn-frames,turn-settle,turn-credit}.ts`;
`src/facet/generation-0/{facet-turn-request,facet-turn}.ts`; `src/workspace/{host,decisions,
executor,computer-operations,github-credential,index}.ts`.

Tests: `test/routes/turns.test.ts` (new), `test/routes/helpers.ts`,
`test/supervisor/projects/{turn-run-helpers,turn-credit-flow,turn-faults}.ts` (new),
`test/supervisor/projects/supervisor-project-turn.test.ts`,
`test/supervisor/threads/turn-slot.ts` (new), `test/supervisor/threads/{threads,turn-lease,
fresh-thread}.test.ts`, `test/supervisor/threads/fake-workspace.ts`, `test/supervisor/helpers.ts`,
`test/facet/generation-0/{facet-turn,facet-turn-loaded}.test.ts`,
`test/facet/generation-0/facet-turn-helpers.ts`, `test/workspace/*` and
`test/supervisor/projects/fake-tenant-workspace.ts` for the deletion.

Docs: `docs/agents/adr/0031-relay-facts-decide-known-good.md`,
`docs/agents/design/feature-map.md`, and the removal of
`docs/agents/design/legacy-workspace-execute-deletions.md` now that it is applied.

## Which question each predicate answers (E12)

`src/supervisor/eligibility.ts` now holds two predicates and says in the file why they are not one.

| predicate | question | evidence | who reads it |
| --- | --- | --- | --- |
| `servedSuccessfulResponse` (was `isCreditedTurn`, logic unchanged: `outcome === "body-completed" && responseStatus < 400`) | Is this generation known good? | A transport fact about one relay attempt (ADR-0031). | `deriveGenerationEligibility` only. |
| `earnsCompletedRealTurnCredit` (new, exported) | Did one real turn complete? | Pi terminal success **and** a committed thread save **and** an attempt still delivering successfully (goal criterion 6). | The turn settlement only, which writes the `completed_real_turns` ledger. |

Nothing in `deriveGenerationEligibility` reads the ledger, so a thread-save failure cannot make a
healthy generation ineligible; and a credited relay attempt never claims a conversation was saved.

## Acceptance criteria

**1. One authenticated project-turn entry.** `POST /api/projects/{id}/turn` (`src/routes/turns.ts`)
reaches `Supervisor.runProjectTurn(projectId, prompt)` (`src/supervisor/projects/turn-run.ts`),
which in order: validates the prompt (non-empty, trimmed, `PROJECT_TURN_PROMPT_MAX_LENGTH` 32 000),
reconciles unresolved evidence, reads the project's thread through the catalog, admits the turn at
the revision it just read, snapshots the active generation and its latest preparation check, then
mounts, provisions, and obtains the per-turn workspace capability through the existing
`streamProjectTurn` path. The request body has exactly one key.
Evidence: `test/routes/turns.test.ts` ("runs the turn the path names with the prompt the body
carries, and nothing else", the eight refused bodies including `tenant`, `messages`, `leaseId`,
`model`); `test/supervisor/projects/supervisor-project-turn.test.ts` (the RPC takes two arguments;
a serving Supervisor obtains the capability from its own binding; an unknown or invalid project id
reaches no thread); `turn-credit-flow.test.ts` ("a turn hands the browser no lease and the
generation no model or tenant" asserts the handoff is exactly `{prompt, messages}`).

**2. Stream validated bounded frames, save, then report.** `turn-stream.ts` reads the generation's
stream inside the Supervisor, proves each line in `turn-frames.ts`
(`PROJECT_TURN_FRAME_MAX_BYTES` 262 144, every accepted frame rebuilt field by field), and forwards
only `text`, `tool-start`, and `tool-result`. The browser's `saved` frame is written by
`turn-settle.ts` after `ProjectThreads.finishTurn` returned committed under the admitting lease, and
only then is the credit recorded. A save that fails answers `save-failed`, abandons the lease, and
records no credit even though the generation said `completed`.
Evidence: `turn-credit-flow.test.ts` ("a completed turn is saved first, then reported, and earns
exactly one credit"; "a turn whose save fails reports no success and earns no credit").

**3. `src/supervisor/eligibility.ts` changed without collapsing the two questions.** See the table
above. A `body-completed` attempt with status 200 and no committed save earns no credit:
`turn-credit-flow.test.ts` "an unsaved relayed request earns no real-turn credit however good its
status" performs a successful `GET /` through the relay and asserts `getCompletedRealTurns()` is
empty, and "a turn whose save fails …" asserts the attempt is still `body-completed`/200 while the
ledger stays empty.

**4. Failed turns, malformed streams, empty EOF.** A Pi `failed` terminal frame saves its
conversation and earns no credit — the documented policy is in `saveFailedTurn`: a model-call limit
or model error still produced conversation the next turn continues from.
Evidence in `turn-faults.test.ts`: missing terminal frame, empty stream, malformed line, unknown
frame kind, frame missing a declared field, oversized frame, and a second terminal frame; each
saves nothing (or, for the duplicate, saves exactly the first conversation once) and earns no
extra credit. `turn-credit-flow.test.ts` covers the failed and rejected endings and the successful
`GET /`.

**5. Cancel on disconnect (Q3 default).** Cancelling the response body cancels the generation's
stream, which ends the Pi turn in `facet/generation-0/facet-turn.ts`; the turn then abandons its
own lease at once and settles the attempt `relay-cancelled`. The save-versus-cancel race is
decided at the durable commit, which is documented in `saveCompletedTurn`: the block is
synchronous inside a single-threaded Durable Object, so a disconnect is observed either before it,
where nothing is written, or after it, where the commit stands.
One honest narrowing of Q3: "keep valid partial Pi messages when the server can save them" has no
messages to keep before the terminal frame, because Pi state travels only in a terminal frame. Text
and tool frames are what the browser saw, not messages Pi handed over. This is stated in
`turn-settle.ts` rather than left implied. Files the turn changed stay changed.
Evidence: `turn-faults.test.ts` ("a browser that goes away mid-turn cancels the work and earns no
credit"; "a save that committed before the disconnect stands, and keeps its credit").

**6. A bounded turn deadline.** `PROJECT_TURN_DEADLINE_MS` is 4 minutes, below the 5-minute
`PROJECT_TURN_LEASE_MS` so the deadline fires while the turn still owns the lease it must release.
It bounds both the start (mount, provision, capability, `startTurn`) and the read. The number is a
stated choice, not a measurement: a turn mounts a cached module map rather than building, so the
cold-build figures do not apply to it; what applies is E8's 2.6-2.9 s Computer cold start on the
pinned pair plus a turn bounded by `MAX_MODEL_CALLS`. T1a's local build chain was 12-15 s with a
900 s recommended container ceiling, and **T1b never ran**, so no recorded cold-build number exists
to calibrate against. The reasoning is in the constant's doc comment.
Later admissions still recover an expired lease (`decideStartTurn` treats a passed deadline as
free), and old finish and abandon callbacks cannot touch a new turn because the lease id fences
them. Pending evidence is reconciled on an existing request path: admission calls
`sweepExpired`. No alarm, no scheduler, no queue, no retry.
Evidence: `turn-faults.test.ts` ("a turn that never ends is bounded, and gives the project back";
"a start that never answers is bounded, and the project does not stay held"; "admitting a turn
reconciles a previous turn's unresolved evidence"); `test/supervisor/threads/turn-lease.test.ts`
and `fresh-thread.test.ts` for the fencing rules, now driven through
`test/supervisor/threads/turn-slot.ts` inside the object that owns them.

**7. Mid-turn activation.** The attribution is snapshotted once at admission and never re-read, so
an activation during a turn decides what the next turn runs on. The admitted turn drains on the
generation that admitted it; it is not cancelled. Manual rollback and generation control are
untouched, and a failed candidate still cannot change the serving facet.
Evidence: `turn-faults.test.ts` "activating a generation mid-turn does not relabel the running
turn's evidence" (active label moves to the new generation, the attempt and the credit stay on
generation 0).

**8. Explicit HTTP answers, no leaks, old choreography removed.** `TURN_STATUS` maps every refusal
to 400/404/409/500/503 and is total over the union, so a new code fails the build rather than
falling into a default. Exceptions become a bare `internal-error`. Cross-origin POSTs are refused
403 by the same rule the project routes use. `startProjectTurn`, `finishProjectTurn`,
`abandonProjectTurn`, and `streamProjectTurn` are gone from the Supervisor's RPC surface; the lease
id never leaves the object. T7's deletion list is applied in `c3ac884`.
Evidence: `test/routes/turns.test.ts` (status table; "a turn that throws answers a bare fault,
carrying nothing from the exception" checks the body contains neither a token nor a path; the
cross-origin test; method and path discipline).

**9. Docs.** ADR-0031's fixture-attribution paragraph now states that traffic serves from the
active generation's retained module map and that a turn snapshots its attribution; the
stream-completion paragraph now states that a turn stream carries a terminal frame the Supervisor
requires while the general relay keeps the `content-length` limit; a new paragraph separates
completed-real-turn credit from relay credit; the sweep paragraph records that admission runs the
sweep and that browser-disconnect propagation is still unproved locally. The decision itself,
the placeholder thresholds, and the absence of automated recovery are unchanged.
`docs/agents/design/feature-map.md` rows for relay attempts and eligibility, project threads, the
HTTP routes, active-generation facet serving, and the coding-agent loop are updated, and rule 4 now
says that recording a saved turn is not an expansion of eligibility policy.

**10. Paid disconnect and deadline measurement.** **BLOCKED: awaiting owner approval for a paid
probe.** No deployment, workspace, or billing call was made. The local cancellation and deadline
tests are not this measurement, and nothing here simulates one.

## What I deliberately did not do

- No page or browser code. `src/page/` is untouched; T10 owns the page that reads this stream.
- No reconnect, resume, background turn, steering, alarm, scheduler, or queue.
- No change to the eligibility thresholds or to any recovery policy.
- No change to `slices.md`: its banner marks it as retained implementation history, so rewriting
  its open questions would falsify the record rather than update a status.
- No change to `docs/agents/design/overview.md`, whose "open design questions" list still names the
  disconnect question. It is the product overview rather than an implementation-status doc, and the
  paid half of that question is genuinely still open.
- No new CONTEXT.md glossary entry for the credit ledger, which the criteria did not ask for.
- No `getCompletedRealTurns` HTTP route. It is an RPC read for tests and for a later status view.

## Notes for the next reader

- The facet's turn request changed from `{prompt, state}` to `{prompt, messages}`
  (`src/facet/generation-0/facet-turn-request.ts`). This is outside T9's listed scope and it was
  necessary: the Supervisor saves a conversation, not a Pi state, and building a `PiAgentTurnState`
  on the Supervisor side would have put the model and the system prompt in the host, which the
  scope note forbids. The model, system prompt, and thinking level are now the generation's own.
- I started from the preserved WIP on `work/T9-stalled` rather than rewriting it, then reviewed
  every file and fixed what it got wrong. It was not green: the duplicate-terminal-frame rule
  depended on how the generation happened to chunk its writes, and one test failed because of it.
  The turn now ends at the first terminal frame and never reads past it, which is deterministic;
  `duplicate-terminal-frame` is deleted rather than left as an unreachable code. I also added the
  bounded start, the admission sweep, the whole `test/routes/turns.test.ts`, and the docs, and I
  corrected the save-versus-cancel comment, which claimed a disconnect settled the relay attempt.
- Frames are queued in the isolate rather than back-pressured: the read loop runs in the stream's
  `start`, so a slow browser does not slow the generation. The volume is bounded by
  `MAX_MODEL_CALLS` and by the tool-result truncation the generation applies, so this is a memory
  bound rather than an unbounded queue. A pull-driven reader would be the fix if a paid run shows
  it matters.
- Noticed and not fixed, being outside this task: `docs/agents/design/overview.md`'s open-questions
  list is stale in several items beyond the disconnect one, and `slices.md` still records the
  completed-real-turn rule as an open choice, which its own history banner makes correct rather
  than wrong.
