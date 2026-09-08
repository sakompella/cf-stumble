# Brief: execute one surface of the web test case list against the real page

You are an end-to-end web testing agent for the cf-stumble v0 finishing run
(`openai-codex/gpt-5.6-luna`, `--thinking high`). Five agents run this brief in parallel, one per
surface. Yours is named in the message that sent you here.

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/cases-<SURFACE> -b work/cases-<SURFACE> origin/work/harness-runner
cd /home/aditya/wt/cases-<SURFACE>
export CF_STUMBLE_CHROME="$(command -v chromium)"
```

Branch from `origin/work/harness-runner`, not from `main`: the runner and the case contract live
there. Work only in your own worktree.

## Read first

1. `tools/browser-harness/CASES.md` in full. It is the contract. Another agent wrote the runner,
   the page helpers, the readers, the assertions and the controllable stub, and documented all of
   it there. Read `tools/browser-harness/cases/chat-*.mts` as the worked example.
2. `/home/aditya/repos/cf-stumble/.audit/v0/web-test-cases.md`, the merged case list. Execute the
   section for your surface, every case, in id order.
3. `/tmp/cf-stumble-v0-handoff-2026-09-08.md`, "The demo that defines done".

## Rules

- Add only `tools/browser-harness/cases/<your-surface>*.mts` and, if you need shared constants,
  `tools/browser-harness/cases/_<your-surface>.mts`. Touch nothing else in
  `tools/browser-harness/`, and nothing at all in `src/`. Those files belong to other agents and
  will conflict.
- If you need a reader, a scenario or a helper that does not exist, write it inside your own case
  file. Do not edit the shared modules.
- Assert observable behavior. A case that passes when the page renders nothing is worthless. Every
  case returns an evidence sentence with your own measured numbers in it.
- **A failing case is a result, not a blocker.** If the page is wrong, leave the case failing,
  and report it as a product defect with the case id, what you observed, what the case list
  expected, and the file and line in `src/page/` or `src/routes/` where the page does it. Do not
  fix the product. Do not weaken the case to make it pass. If the case list itself is wrong about
  the product, say that instead and quote both.
- Keep each file under 300 lines and each `run` under 50 lines; lint enforces both.
- Wrap every long command in `timeout` and redirect output to a file. Never leave a browser or
  server running without one.

## The gate

`pnpm verify` green before every commit (the pre-commit hook runs it), then
`timeout 900 pnpm harness:browser > /tmp/harness-<your-surface>.log 2>&1` and read the summary.
Rebase on `origin/work/harness-runner` before you push. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/cases-<SURFACE>`.
Do not merge.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 400 words:
your branch and SHA, the harness summary line, one line per case with pass or fail and the evidence
sentence trimmed, every product defect you found with its location, and every case in the list you
could not express with the contract and why.
