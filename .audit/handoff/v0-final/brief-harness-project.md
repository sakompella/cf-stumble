# Brief: the harness is a project in the sidebar (handoff decision 4)

You are a code worker for the cf-stumble v0 finishing run. The orchestrator merges; you do not.

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/harness-project -b work/harness-project origin/main
cd /home/aditya/wt/harness-project
```

Work only there. Read `.audit/` from `/home/aditya/repos/cf-stumble/.audit/`.

## Read first

1. `/tmp/cf-stumble-v0-handoff-2026-09-08.md`: decision 4, the section "How the agent edits its own
   harness", and demo step 2.
2. `/home/aditya/repos/cf-stumble/.audit/v0/realignment-notes.md`, the owner's own words. It says
   the harness entry only selects the existing clone at `/workspace/harness`, that edits are
   committed there, and that submission uses that commit SHA. No new clone, workspace, or commit
   machinery.
3. `docs/agents/design/feature-map.md` and `docs/agents/design/computer-integration.md` on this
   branch. They were rewritten today and are current.
4. `~/.agents/skills/poteto-mode/SKILL.md`, and work in that style. Name the data shape before you
   write logic.

## The gap, already verified

`GET /api/projects` returns only connected GitHub repositories. There is no harness entry, so the
sidebar cannot offer the harness as a working directory and demo step 2 cannot be performed against
the harness. `src/supervisor/supervisor.ts:210` is `listProjects`; the page renders the list in
`src/page/`; a turn's working directory is chosen at `src/supervisor/projects/project-turn.ts:146`
from `projectDirectory(resolved.project.id)`, and `src/workspace-layout.ts` owns both
`projectDirectory` and `HARNESS_DIRECTORY`.

## What to build

The smallest change that gives the sidebar a harness entry and lets a turn run in
`/workspace/harness`:

- One selectable target, not two concepts. Decide the data shape first: the existing project rows
  plus one harness entry that is not a connected repository and has no GitHub authorization, and a
  resolver that turns a selected id into a working directory (`projectDirectory(id)` for a project,
  `HARNESS_DIRECTORY` for the harness). Make the illegal states unrepresentable rather than adding
  a boolean that half the call sites forget.
- The harness entry must not need a connection, a clone step, or a credential. It always exists.
- Selecting it starts a turn in `/workspace/harness` with the same project capability, the same
  thread rules (one current thread per selectable target, fresh thread resets it) and the same turn
  lease. It is a working-directory selection and nothing else.
- The path guard stays the workspace root, and the harness entry may not reach outside
  `/workspace`.
- The page shows the entry in the sidebar and can select it. Keep the existing markup and script
  structure; do not restyle the page.

Do not add per-project workspaces, a second Computer instance, a commit UI, or a harness clone
step. Do not touch the Access boundary, the generation control path, or R2 (another worker is
replacing that right now, so stay out of `src/supervisor/artifacts/`).

## Tests

Cover the behavior, not the wiring: the list contains the harness entry with no connection, a turn
selected on the harness entry starts in `/workspace/harness`, a turn selected on a project starts
in that project's directory, the harness entry has its own thread and a fresh thread on it does not
touch the project's thread, and a selected id the catalog does not know is still
`unknown-project-id`. Follow the existing test style in `test/supervisor/projects/`.

## The gate

`pnpm verify` green before every commit; the pre-commit hook runs it. `pnpm format` fixes
formatting. Also run `export CF_STUMBLE_CHROME="$(command -v chromium)"` then
`timeout 300 pnpm harness:browser > /tmp/harness-browser.log 2>&1` and report the result, because
you changed the page. Wrap every long command in `timeout` and redirect output to a file.
Rebase on `origin/main` before you push, then verify again. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/harness-project`.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 450 words: the
data shape you chose and the alternative you rejected, branch and SHAs, `git diff --stat
origin/main`, the tests you added and what each would catch, the `pnpm verify` line, the browser
harness result, and anything in this brief that was wrong.
