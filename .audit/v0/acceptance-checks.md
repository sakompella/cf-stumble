# Objective acceptance checks

A worker's report is a CLAIM. These are falsifiable shell checks the dispatcher runs against the
worktree (or the merged tree) without reading the worker's prose. Machine-readable copy:
`.audit/v0/acceptance-checks.json`. Runner: `await audit("T2")` in the root REPL.

They are deliberately crude. They cannot prove a task is done; they can prove a task is NOT done,
which is the failure mode that matters when a worker grades itself. A green board here still
requires reading the report and the diff.

| task | check | why this one |
|---|---|---|
| T1a | `build:artifact` exists in `package.json` | B2 Gap 1(a) — the single owning script |
| T1a | `src/harness-build.ts` names `build:artifact` | B2 Gap 1(b) — deployed command cannot drift |
| T1a | a test references `buildCommand` | B2 Gap 1(c) — catches a later rename |
| T1a | a committed clean-build script exists | B2 Gap 1(d) — prose evidence is not proof |
| T1a | `vendor/**/dist` still untracked | the wrong fix E1 warns about |
| T2 | `control/journal.ts` gone | ADR-0030; the module should not survive |
| T2 | no `requestId`/`fingerprint`/journal in `src` | 58 refs measured before dispatch |
| T2 | `epoch` still present in `control/` | epoch fencing must SURVIVE the deletion |
| T4 | route mentions a stream type | E5 — it had none |
| T4 | `await model.run(request)` no longer the single hop | E7 — the exact collapse point |
| T4 | `FORBIDDEN_FIELDS` and the fixed MODEL intact | must not be traded away for streaming |
| T4 | a mid-stream failure test exists | the easy thing to skip |
| T5 | unfenced `finishTurn` gone from `store.ts` | E2 — delete the unsafe path, not the safe one |
| T5 | `leaseId` reaches `project-threads.ts` and `supervisor.ts` | E2 — the client must be able to return it |
| T5 | `WithLease` has callers outside `store.ts` | E2 — it had ZERO before |
| T5 | a fresh-thread/reset test exists | criterion 3, the revision-zero race |


## T7 (added mid-flight, 03:50)

T7 deleted the legacy buffered path (-1119 lines). At that moment `git_diff` was gone from
`src/facet/` entirely and `pi-agent-turn.ts` still bound only four tools (read, write, edit, bash).
The surviving `git-diff` references are workspace-side (`workspace/executor.ts`,
`workspace/decisions.ts`), which is a capability, not a tool the agent can call.

| check | why |
|---|---|
| Pi path has a diff capability | review B3 — deleting the only diff-producing code breaks goal criterion 4 and demo step 3 |
| legacy buffered turn path deleted | the competing turn definition should not survive |
| `vendor-pi.mts --check` passes | proves `vendor/**` was regenerated, not hand-edited |
| compaction reachable from the facet | goal criterion 5 |
| a diff-related test exists | prose is not proof |

**`pnpm verify` cannot catch the diff regression**, because no existing test requires a diff on the
Pi path. That is the whole reason this objective check exists: the gate stays green while the
product loses a required behaviour.
