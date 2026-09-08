# Brief: delete the recovery, eligibility and turn-credit machinery (handoff decision 7)

You are a code worker for the cf-stumble v0 finishing run. The orchestrator merges; you do not.

## Where to work

Create your own worktree from current `origin/main` and work only there:

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/simplify-recovery -b work/simplify-recovery origin/main
cd /home/aditya/wt/simplify-recovery
```

Never touch `/home/aditya/repos/cf-stumble` or any other worktree. Another agent is working there.
`.audit/` does not exist in your worktree; read it from `/home/aditya/repos/cf-stumble/.audit/`.

## Read first

1. `/tmp/cf-stumble-v0-handoff-2026-09-08.md` in full. Decision 7 is your task, and the "demo that
   defines done" section gives you the deletion rule you must apply.
2. `/home/aditya/repos/cf-stumble/AGENTS.md` and `docs/agents/domain.md`.
3. `/home/aditya/repos/cf-stumble/.audit/v0/realignment-notes.md`, the owner's own words.
4. `~/.agents/skills/poteto-mode/SKILL.md`, and work in that style.

## The deletion rule (from the handoff, quote it to yourself before each judgement call)

"Delete only what nothing in these seven steps depends on for behavior, authorization, or
persistence. When unsure, keep and move on."

**The turn lease STAYS.** So does everything the seven demo steps need: streaming a real turn,
thread persistence, generation submit / activate / rollback, the startup check, Access
verification, workspace provisioning, the project sidebar.

## What to delete

Verified inventory at `main` `0dd7c0b`. Treat it as a starting map, not as gospel; if a file is not
what this brief says it is, say so in your report rather than forcing the deletion.

- `src/supervisor/recovery/` entirely: `candidate.ts`, `episode.ts`, `index.ts`, `operations.ts`,
  `store.ts`, and `persistence/{error,model,operation-row,row-phase,row}.ts`.
- `src/supervisor/eligibility.ts`.
- `src/supervisor/projects/turn-credit.ts`.
- Relay-attempt tracking: `src/supervisor/relay/attempts.ts` and `src/supervisor/relay/attempt.ts`,
  plus the `relayAttempts` field and its wiring in `src/supervisor/supervisor.ts`. Keep the relay
  itself (`FacetRelay`) if the seven steps need it to reach the facet; decide by reading it.
- The recovery HTTP route `src/routes/recovery.ts` and its registration in `src/routes/`.
- The page status drawer: `src/page/script-status.ts`, `src/page/markup-drawer.ts`, and the element
  ids and page wiring that exist only for it. The chat stream, the generation controls and the
  project sidebar all stay.
- Every test of the code you delete, including
  `test/supervisor/recovery/`, `test/supervisor/eligibility*.{ts,props.test.ts}`,
  `test/supervisor/eligibility-fixtures.ts`, `test/supervisor/relay/relay.test.ts` (only the
  attempt-tracking parts if the file also covers the surviving relay),
  `test/supervisor/projects/turn-credit-flow.test.ts`, `test/routes/recovery-report.test.ts`, and
  the credit or eligibility assertions inside files that also test surviving behavior
  (`test/supervisor/projects/turn-faults.test.ts`, `test/supervisor/epoch-scope.test.ts`,
  `test/supervisor/evidence-era.test.ts`, `test/routes/owner-api.test.ts`,
  `test/supervisor/projects/turn-run-helpers.ts`).
- SQLite tables that only this machinery wrote. Deleting the writer and leaving a `CREATE TABLE`
  behind is not a deletion. There is no migration requirement: no deployed instance holds data
  anyone needs.
- ADRs that no longer apply: `docs/agents/adr/0031-relay-facts-decide-known-good.md` and
  `docs/agents/adr/0032-recovery-bounds-an-episode-it-does-not-perform.md`. `docs/agents/domain.md`
  says to delete an ADR that no longer applies rather than leave it as current guidance, and
  `test/docs/adr-index.test.ts` checks `docs/agents/adr/README.md`, so remove their index entries
  in the same commit. Read both ADRs first: if one records a decision the surviving code still
  depends on, keep it and say why in your report.

Do not delete anything else. Do not rename. Do not "improve" surviving code. Do not add features.
If deleting X forces a change in surviving code, make the smallest change that keeps the surviving
behavior, and name that change in your report.

## Commit shape

One commit if the deletion is one thought; otherwise a small ordered series where each commit
passes the gate on its own. Never bundle an unrelated fix. Commit messages follow this
repository's style: read `git log --oneline -20` and match it. Lowercase type, scope, imperative
subject, a body that says why the code is gone.

## The gate

`pnpm verify` in your worktree, green, before every commit. It takes about 70 seconds and
`.githooks/pre-commit` runs it for you. `pnpm format` fixes formatting; nothing else is
auto-fixable. Never commit through a red gate. If a surviving test fails because it asserted
deleted behavior, that is your call to make with the deletion rule, and your report must name
every test you changed rather than deleted.

Before you push, rebase on the latest `origin/main`:
`git fetch origin && git rebase origin/main`, then run `pnpm verify` again.

Push with:
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/simplify-recovery`

## Report

Reply to your parent with `await agent_message.send(..., receiver_role='parent')`, under 500 words:
the branch and commit SHAs, the file count and line count deleted (`git diff --stat origin/main`),
every judgement call you made and which way you went, every surviving file you had to change and
why, the `pnpm verify` result line, and anything in this brief that turned out to be wrong.
