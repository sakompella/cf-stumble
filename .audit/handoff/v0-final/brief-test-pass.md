# Brief: the bounded test-deletion pass (handoff decision 11)

You are a code worker for the cf-stumble v0 finishing run. This work is explicitly **never
release-blocking**. It stays on its own branch and merges only when it is finished and green. If it
is not finished when the release is, it is abandoned rather than rushed.

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/test-pass -b work/test-pass origin/main
cd /home/aditya/wt/test-pass
```

Work only there. Read `.audit/` from `/home/aditya/repos/cf-stumble/.audit/`.

## Read first

1. `/tmp/cf-stumble-v0-handoff-2026-09-08.md`, decision 11 and the deletion rule in "The demo that
   defines done".
2. `/home/aditya/repos/cf-stumble/.audit/v0/review-sol-tests.md`. It names the decorative tests
   this pass may delete. It was written before today's deletions, so some of its subjects are
   already gone.
3. `AGENTS.md`, `docs/agents/domain.md`, `~/.agents/skills/poteto-mode/SKILL.md`.

## What you may delete, and nothing else

1. Tests `review-sol-tests.md` names as decorative.
2. Tests of code deleted today. Four commits landed: the caller-supplied-tenant guard, the
   recovery, eligibility, turn-credit and relay-attempt machinery, the R2 module-map cache, and the
   `ctx.id.name` fallback. Their own tests went with them, so what is left here is a leftover
   assertion inside a file that also tests surviving behavior.
3. Obvious duplicates you find on the way. A duplicate is two tests that fail together for one
   reason. Prove it before you delete: state which test you kept and which single fault both would
   have caught.

## How to tell a decorative test from a real one

Mutation is the review. Change the production line the test claims to protect and watch for red. A
test that stays green under that mutation is decorative. Do that for every test you delete on
suspicion, and put the mutation and the result in your report. This is the standard the previous
run earned, and it is the only evidence that counts here.

## What you may add

At most three property tests, using the Hegel setup the repository already has
(`@hegeldev/hegel`; look at how existing `*.props.test.ts` files are written). Zero new tooling.
The two properties worth stating:

- The generation epoch never goes backwards and every accepted control request observes the current
  epoch.
- A turn lease admits one turn at a time, and a stale lease can neither complete nor cancel a
  replacement turn.

Only add one if the existing suite does not already state it. Say in your report which you added
and which you found already covered.

## Rules

- Do not touch `src/`. If a test deletion needs a source change, that is a different task; report
  it.
- Do not reduce the test count for its own sake. A test that would catch a real fault stays, even
  if it looks redundant.
- Wrap every long command in `timeout` and redirect output to a file.

## The gate

`pnpm verify` green before every commit; the pre-commit hook runs it. Rebase on `origin/main`
before you push and verify again; `main` is moving today. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/test-pass`.
Do not merge.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 500 words:
branch and SHAs, the before and after test counts, every test you deleted with the mutation that
proved it decorative, every test you kept that you had expected to delete, the property tests you
added, and the `pnpm verify` line.
