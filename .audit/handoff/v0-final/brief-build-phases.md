# Brief: make a harness build one step per phase

You are a code worker for cf-stumble. The orchestrator merges and deploys; you do not.

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/build-phases -b work/build-phases origin/main
cd /home/aditya/wt/build-phases
```

Work only there. Read `.audit/` from `/home/aditya/repos/cf-stumble/.audit/`.

## The measured problem

A harness build runs as one shell command, `pnpm run build:artifact`, inside the tenant's Computer
container, driven by one Durable Object RPC from the Supervisor. On the deployed account that
command is dying at about 690 seconds, three times in a row, in three different ways:

| build step wall time | what came back |
|---|---|
| 671 s | `build-workspace-unavailable`, and the Durable Object log says "Durable Object connection closed because the object was reset" |
| 692 s | `build-workspace-unavailable`, same reset |
| 696 s | `build-step-failed` exit 1, with **empty stdout and empty stderr** |

Every build that ever succeeded on this account was 527 s or shorter. The install phase alone is
now 39 s, measured in the deployed container, so the remaining time is the two compile phases.

Because the whole build is one command piped through `tail -c 4000`, a killed build loses all of
its output, and there is no way to tell which phase was running. That is the immediate blocker: the
owner's instance cannot bootstrap, and neither can anyone who forks the project.

## What to build

Make each phase of a build its own planned step, so each is its own RPC, its own exit code and its
own log line, and no single command has to survive for eleven minutes.

Today `src/harness-build.ts` has:

```ts
buildCommand: "pnpm run build:artifact",
```

and `planHarnessBuild` emits four steps, `provision`, `isolate`, `checkout`, `build`, where the
build step is `cd <scratch>` followed by that one command piped into `tail -c 4000`.

Replace the single build phase with three, in this order:

1. install, running `pnpm install --frozen-lockfile --reporter=silent --ignore-scripts`
2. the vendored Pi build, running `pnpm run build:pi`
3. the module map build, running `pnpm run build:module-map`

Requirements, each of which exists for a reason you can read in the repository:

- Every phase still names a script `package.json` defines, or a flag-only `pnpm install`.
  `test/supervisor/artifacts/build-command.test.ts` holds that rule so the deployed build and the
  local gate cannot drift; keep the rule, and adapt the test to the new shape rather than deleting
  it. Adding a `build:install` script to `package.json` is a good way to keep it.
- Keep `build:artifact` in `package.json`. It is what a developer and the clean-build probe run
  locally, and `scripts/probe/clean-build.sh` uses it.
- Every step keeps its working directory inside the workspace and names the scratch path in the
  command itself, because Computer resolves a working directory against the workspace and refuses
  one outside it. Read the comment in `src/workspace-layout.ts` for why the scratch path is
  `/tmp/cf-stumble-builds/<commit>`.
- Keep the bounded output. Computer holds a command's output in memory, and an unbounded
  `pnpm install` log made the container exit 1. Each phase keeps `set -o pipefail` and
  `tail -c 4000`, so a phase that fails still reports its own tail.
- The step names travel in an RPC request and are validated. `HARNESS_BUILD_STEP_NAMES` and the
  parser in `src/workspace/harness-build.ts` both need the new names, and a request naming a step
  that does not exist must still be refused as `unknown-command`.

## Tests

Update, do not delete. At least these will need work: `test/workspace/harness-build.test.ts`,
`test/workspace/harness-build-isolation.test.ts`, `test/supervisor/artifacts/module-map-build.test.ts`,
`test/supervisor/artifacts/build-workspace.test.ts`, `test/supervisor/artifacts/build-stub.test.ts`
(it asserts one stub per call, so the count changes), `test/supervisor/artifacts/build-command.test.ts`.

Add one test that states the property this change exists for: the phases run in order, and each is
a separate step whose failure names that phase rather than the whole build.

## Rules

- Do not change the Access boundary, the page, the turn path or the module-map store.
- Wrap every long command in `timeout` and redirect output to a file.
- No narrating comments. A comment earns its place by saying why, and the deployed measurements
  above are the why.

## The gate

`pnpm verify` green before every commit; the pre-commit hook runs it. `pnpm format` fixes
formatting. Rebase on `origin/main` before you push, then verify again. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/build-phases`.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 450 words: the
branch and SHA, the step names you chose, how a failing phase now reports itself, every test you
changed and why, the `pnpm verify` line, and anything in this brief that turned out to be wrong.
