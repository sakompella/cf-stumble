You revise a roadmap document. You write ONE file. You touch no source code and no tracked repo file.

Repo: /Users/aditya/repos/projects/cf-stumble (your cwd). Everything below is under `.audit/v0/`.

## Read
1. `.audit/v0/roadmap-v0.md` — the roadmap to revise (T1-T12, waves 0-5).
2. `.audit/v0/review-opus-round1.md` — an adversarial review. Verdict SHIP WITH FIXES. Its
   blocking objections B1-B8, its defect table (section 3), its collision table (section 4) and its
   coverage map (section 5) are the change list. Treat them as correct unless a source read
   contradicts them.
3. `.audit/v0/evidence/E1..E8` — findings already CONFIRMED from source by the dispatcher. Fold the
   relevant ones into the tasks they belong to, so no worker rediscovers a known fault.
4. `.audit/v0/decision-log.md` — decisions D24 through D35 are already made and are binding.
   Reflect them; do not relitigate them.
5. `.audit/v0/goal.md` — the ten done-criteria and the cut line. The roadmap must cover all ten.

## Write exactly one file: `.audit/v0/roadmap-v0.approved.md`

Apply the review's fixes. Concretely, at minimum:
- Split T1 into **T1a** (local build correctness + the B2 Gap 1 regression proof, deps none) and
  **T1b** (paid capability/build/load gate, deps T1a). T1a is ALREADY DISPATCHED with the B2 items;
  keep its text consistent with that.
- Split T6 into **T6a** (unsupervised: connected-project storage, variable-arity catalog, ownership
  resolution, routes, provisioning wiring, testable with a fake credential) and **T6b** (the one
  owner-run device authorization + private-repo clone proof, a wave-5 owner step).
- Split T3: deterministic layout work (T3.1-T3.3) apart from the paid concurrency experiment (T3.4).
- Fix the dependency graph: the `Dependencies: T1` on T2, T4, T5 and T8 is fictional. Set real
  semantic prerequisites only.
- T7: add an acceptance item that the Pi path can still produce a repository DIFF (goal criterion 4
  and feature-map demo step 3 need it; T7.5 currently deletes the only diff-producing code as a
  "duplicate tool" — it is not a duplicate). Add `tools/vendor-pi.mts` to T7's scope with the rule
  that vendored exports are regenerated via `pnpm exec tsx tools/vendor-pi.mts --refresh-generated`
  and `vendor/**` is never hand-edited. Tell the worker NOT to attempt `--update`.
- T9: add `src/supervisor/eligibility.ts` to scope. Line 140 currently credits any `body-completed`
  with status < 400, with no requirement that the thread was saved. Goal criterion 6 forbids that.
- T11: give it authority to land narrow fixes with a named regression test, or add a fix reserve.
  Re-size it: six criteria spanning threads, leases, generations, cache, credentials and property
  tests is not M.
- Coverage gaps from review section 5: add an owner-only Access policy acceptance item plus a local
  rejection test (criterion 2); make the two-clean-build proof say **Computer** (criterion 7).
- Resolve the two decisions the review says must not be left to a worker: T2 acceptance 4 becomes
  "an already-ready candidate returns current status; no implicit re-preparation", and T5
  acceptance 3 picks durable thread identity.
- Cut-line guard: add "no alarm, no scheduler, no queue framework" to T3.4, matching T9.5.
- Collisions: state file ownership per wave, per review section 4. `capabilities.ts` belongs to T4
  in wave 1. Enumerate T3's test paths instead of "related tests". T2's page work is DELETE ONLY.
- Every paid or account-touching task must carry: the preconditions from B8 (named non-production
  account or run prefix, spend cap, disposable GitHub repos), "stop on the first paid failure and
  record it", and "missing paid authorization means BLOCKED, not passed — never fake or simulate a
  paid result".

## Rules
- Keep the existing structure: Dispatch contract, Waves table, one section per task with Why, Scope,
  Acceptance criteria, Verification command, Dependencies, Size, Owner tier.
- Keep stable ids. Where a task splits, use the a/b suffix. Add a short "Changes from
  roadmap-v0.md" section at the end listing every edit and the objection id that caused it.
- Follow `/Users/aditya/.agents/skills/writing-for-agents/SKILL.md`: these tasks are read by coding
  agents. Precise, falsifiable acceptance criteria. No filler.
- Do not weaken any acceptance criterion to make it easier. Do not add scope beyond `goal.md`'s cut
  line. Do not modify any file except `.audit/v0/roadmap-v0.approved.md`.
