# Brief: correct the "First run" section of the deploy guide

You are the documentation and prose role (`openai-codex/gpt-5.6-terra`, `--thinking medium`).

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/first-run -b work/first-run origin/main
cd /home/aditya/wt/first-run
```

Change only `docs/deploy.md`.

## The section is wrong, and it is the paragraph that will strand a reader

`## First run` currently says that on the first authenticated owner request the Supervisor creates
the workspace, clones the harness repository and labels HEAD as the first candidate. **It does
not.** This was measured against the owner's own deployed instance today.

What actually happens, all verified:

- A new instance answers `GET /api/status` with `{"activeGeneration":{"epoch":0}}`, and every other
  route that relays to a generation answers HTTP 503 `{"ok":false,"problem":{"code":"no-active-generation"}}`.
  That includes `/`, `/status`, `/generations`, `/projects` and `/health`.
- Nothing bootstraps on its own. The owner has to submit the first candidate explicitly, with
  `POST /api/generations/submit` and a `harnessCommit`, then activate it with
  `POST /api/generations/activate` naming the label and the epoch that `GET /api/status` reports.
- The Supervisor's identity comes from the verified Access identity and audience, so each verified
  owner identity gets its own Supervisor and its own workspace. A reader who tested with one
  identity and then signs in as another will find a second, empty instance. That is the design.

Measured on the owner's instance, first run, cold:

```
submit   -> candidate labeled generation 2, epoch 3, then preparation "ready",
            startup check GET / answered 200                            321 s
activate -> activated, epoch 5                                          0.4 s
GET /    -> 200 "generation-0 main facet ready"                         0.3 s
GET / with Accept: text/html -> the owner page, 42483 bytes
```

## What to write

Rewrite `## First run` so a reader can actually get from a deployed Worker to a serving instance.
It must give them:

- What they see before they do anything, in the exact words the instance answers, including that a
  503 `no-active-generation` is normal at this point and not a broken deployment.
- That the first generation is something they submit, not something that happens, and the two
  requests that do it, with where the label and the epoch come from.
- What one submission does on their behalf, which is clone or reconcile the harness repository into
  `/workspace/harness`, extract the commit, install, build the vendored Pi package, bundle the
  module map, store it in the Supervisor's SQLite storage, cold-start a candidate and run `GET /`
  against it. Say that these are separate build steps, so a failure names the phase.
- Roughly how long to expect, from the numbers above, and that a failed candidate leaves whatever
  was serving still serving.
- That repeating a submission for a commit it already knows returns the existing generation, so a
  retry is safe.
- One sentence that each verified Access identity is its own instance with its own workspace.

Also check the `## Known untested areas` list and the troubleshooting section against this, and fix
anything that now contradicts it. Do not restructure the rest of the guide.

## Rules

Plain technical English, short sentences. No long-dash character. No colon as a mid-sentence
connector; a colon before a list is fine. Run the `writing-for-agents` skill, then `humanizer`,
then `unslop`, and say what each changed.

## The gate

`pnpm format` then `pnpm verify` green before the commit; the hook runs verify. Rebase on
`origin/main` before you push. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/first-run`.
Do not merge.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 300 words: the
branch and SHA, the new section text, anything else you had to correct, what each pass changed, and
the `pnpm verify` line.
