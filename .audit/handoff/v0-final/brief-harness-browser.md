# Brief: make `pnpm harness:browser` work and write the README it advertises

You are the documentation and prose role for this run (`openai-codex/gpt-5.6-terra`).

## The fault, already verified

`package.json` defines `"harness:browser": "pnpm exec tsx tools/browser-harness/run.mts"`, and
`tools/browser-harness/run.mts` has never existed. The real entrypoint is
`tools/browser-harness/smoke.mts`. `AGENTS.md` also tells every agent to read
`tools/browser-harness/README.md` before changing the page, and that file does not exist either.
Both faults are on `main`. Verify both claims yourself before you change anything, and say so in
your report if either is wrong.

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/harness-fix -b work/harness-browser origin/main
cd /home/aditya/wt/harness-fix
```

Work only in that worktree.

## What to do

1. Make `pnpm harness:browser` run the harness. Prefer pointing the script at the file that
   exists over creating a second entrypoint.
2. Run it: `export CF_STUMBLE_CHROME="$(command -v chromium)"` then `pnpm harness:browser`. It
   needs about a minute. Report exactly what it asserts and what it printed. If it fails, fix only
   what is broken about running it, and report anything you had to leave broken. Always wrap a
   long command in `timeout`, redirect its output to a file, and never leave a foreground server
   running without a timeout.
3. Write `tools/browser-harness/README.md`, the file `AGENTS.md` promises. It must tell the next
   agent: what the harness proves and what it cannot prove (it never proves anything about
   Cloudflare Access, which needs a deployment), how to run it, what `CF_STUMBLE_CHROME` is for,
   which surfaces it covers, where the stub owner API lives, and how to add a case. Read the
   harness source before you write a word of it. Keep it short enough that an agent reads all of
   it.
4. Read `docs/agents/writing-style.md` and run the `writing-for-agents` skill, then `humanizer`,
   then `unslop` over the README.

Do not change the page, the Worker, or any test. This is a tooling and documentation fix.

## The gate

`pnpm verify` green before each commit; `.githooks/pre-commit` runs it. `pnpm format` fixes
formatting. Rebase on `origin/main` before you push, then verify again. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/harness-browser`.
Do not merge to `main`.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 350 words:
branch and SHA, what the harness asserted when it ran, the `pnpm verify` line, what each skill
pass changed, and anything still broken.
