# Version zero: what was built and why

A record of the work, written at wrap-up. It covers every task that shipped, the reviews that
redirected the work, and the decisions those reviews forced. Reasoning in full lives in
`.audit/v0/decision-log.md`; the decision ids below point into it.

## How the work ran

The owner briefed an expensive advisor (`gpt-6-astra`) to critique the architecture and write a
roadmap to version zero, then had cheaper agents implement it, one git worktree per task, with two
gates on every task: `pnpm verify` green, and a written report. A second vendor reviewed the result.

Five faults were named by the advisor and confirmed independently against the source before any code
was written: a build that could not run from a clean checkout, a turn lease that protected nothing,
a workspace layout the approved decisions had already superseded, a project catalog whose type
allowed exactly two projects, and a model route that could not stream. Later reading added a sixth:
the coding half of the product had no HTTP surface at all.

## What shipped

| task | change                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1a  | A labeled harness commit builds from a clean checkout. Adds `scripts/probe/clean-build.sh` and a test that keeps the build command and the config aligned.                                  |
| T2   | Applies generation requests directly. Deletes the request id, the fingerprint, and the journal replay (ADR-0030).                                                                           |
| T5   | The admitting lease became mandatory to finish or abandon a turn. The worker collapsed a duplicate method pair instead of wiring the unused one, which was better than the brief asked for. |
| T3a  | Every repository now lives in one workspace per tenant, replacing one container per project.                                                                                                |
| T4   | The model route streams real model events instead of one buffered message.                                                                                                                  |
| T7   | The Pi turn path gained instructions, compaction, and a diff.                                                                                                                               |
| T6a  | GitHub repositories connect with a testable credential, and the project catalog stopped being a two-item tuple, so a third project can exist.                                               |
| T9b  | One HTTP route owns the saved streamed turn. It also split one overloaded predicate in two: whether a response was served, and whether a turn earned completed-real-turn credit.            |
| T13  | The turn's diff became the harness's job rather than a sentence in a prompt the model could skip (ADR-0040).                                                                                |
| T10  | The connected project conversation moved onto one page, and the hardcoded single project id went away.                                                                                      |
| T14  | That page learned to render the two diff frames T13 had started emitting.                                                                                                                   |
| T15  | One turn owns its whole lifetime: one absolute deadline, cancellation carried through provisioning, start, streaming, and workspace work, and late starts disposed of.                      |
| T16  | A failed turn stops earning credit. Terminal rejection and model failure no longer count toward eligibility.                                                                                |
| T19  | The streamed model route is finally covered at its entrypoint rather than only through helpers.                                                                                             |
| T18  | The browser harness the repository advertised became real code instead of a missing file.                                                                                                   |
| T20  | A local probe of the pinned x64 workspace image, run under Podman.                                                                                                                          |

## What did not ship

- **T17, the real-Git diff test.** Paused, complete work preserved on `work/T17`. It failed the
  repository's lint gate on the new process adapter. The design is settled and the code is written;
  only the style pass remains.
- **T21, compaction across a reload.** Dropped. When a conversation outgrows the model's context
  window the system compacts it; the untested chain is compact, save, restart the Supervisor, swap
  in a replacement generation, keep talking. Only the isolated component is tested today. An agent
  was assigned and produced nothing. This is a known untested area, not a known bug.

## The reviews, and what they changed

**Round one, the roadmap** (D18). The Codex quota was exhausted, so `claude-opus-5` reviewed in place
of `gpt-5.6-sol`. Verdict: ship with fixes. It deleted dependencies the roadmap had invented, split
oversized tasks, and caught that the build fix proved nothing without a regression test — which
produced T1a's clean-build probe.

**Round two, the merged code** (D65, D67). Same substitution, same reason. It found that T7's diff
test hand-fed output to a fake and would pass with `git diff` renamed to `cat`. That produced T13.

**Four cross-vendor reviews** (`.audit/v0/review-sol-*.md`), run once the Codex quota reset:

- _The merged code_: **not sound**. The turn deadline applied twice under one lease, a timed-out
  start was never cancelled, mount and credit read the active generation at different moments, and
  failures settled as successes. T15 and T16 answer these.
- _The tests_: **binds with gaps**. Proved by mutation, not argument: replacing the diff command with
  `cat` left thirteen tests green, and emptying the streamed route's entrypoint left twenty-one
  green. T17 and T19 answer these.
- _The unmerged page work_: **merge**. It reconstructed the merge itself and ran the gate.
- _The plan_: **holds with fixes**. It found the compaction gap and a mis-specified paid request.

Round two had read the same tree as _sound with fixes_. The cross-vendor read disagreed and was
right, which is the argument for paying for a second vendor.

**The advisor's second pass** (D74, `.audit/v0/review-astra-low.md`) confirmed the plan and sharpened
three things:

1. An abort signal is not a safety guarantee. A shell command already running keeps writing, so
   admitting a replacement turn must establish that the old turn lost the ability to change the
   workspace, and refuse rather than proceed when it cannot.
2. Half the diff problem is design, not discipline: "the turn's diff" had no defined meaning.
   `git diff HEAD` misses a new file, misses a commit made during the turn, and includes mess that
   was already there. The contract comes before the test.
3. Retracting the broken browser command was withdrawn as an option. It repairs the documentation
   without satisfying the user-interface criterion.

## Decisions worth carrying forward

- **The paid environment is approved** and always was. Recorded in
  `docs/agents/design/computer-integration.md`. The rules: the account is disposable, a local
  container run is local evidence and never deployed-platform proof, a probe that cannot run states
  its blocker, and every run keeps its output (D75).
- **Criterion 10 splits** into acceptance and publication, so an open publication question cannot
  block a finished release (D76).
- **Assert the property, not the location.** Three separate acceptance checks failed because they
  encoded the shape the author imagined rather than the requirement, and each time the worker's
  alternative was better.
- **Mutation is the test review.** Change the production line and watch for red. A green suite under
  mutation is decoration. This caught two generations of the same fake diff test.
- **A one-token probe is not evidence a real run fits.** A probe returned success on the last of the
  quota, and the real review then failed for four days (D65).
- **Dispatch a consumer after its producer.** The page was built before the frames it had to render
  existed, which cost an extra task (D69).
- **Merge-sized steps.** An orchestrator once held seven parallel tasks and exhausted its budget
  before merging any of them; every worktree survived only because the work was committed by hand
  afterwards. Land one task, push, then start the next.

## Where the work runs

An x86-64 Linux box, because the pinned workspace container image is x64 and an arm64 Mac cannot run
it. Node is pinned to 22 to match the version that image ships. `workerd` needs a generic-Linux
loader, which on NixOS means nix-ld; the binaries are never patched.

## Final state at wrap-up

`main` is `e73bc6c` on origin. The gate is green: **118 test files, 852 tests**, up from 642 tests at
the start of this work. Sixteen tasks merged. One is paused on `work/T17` and one was dropped.

| task                    | outcome                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| T15, T16, T19, T18, T20 | merged in this final sweep, gate green after each, pushed one at a time                                        |
| T17                     | paused, work preserved on `work/T17`, unmerged: it fails the repository's lint gate on its new process adapter |
| T21                     | dropped, produced no code                                                                                      |

Every unmerged branch is on origin. Nothing is left only on a working copy.
