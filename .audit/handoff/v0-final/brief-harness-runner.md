# Brief: build the browser harness runner the case list needs

You are a code worker for the cf-stumble v0 finishing run. The orchestrator merges; you do not.

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/harness-runner -b work/harness-runner origin/main
cd /home/aditya/wt/harness-runner
```

Work only there. Read `.audit/` from `/home/aditya/repos/cf-stumble/.audit/`.

## Read first

1. `/home/aditya/repos/cf-stumble/.audit/v0/web-test-cases.md`, the merged case list (40 cases,
   6 surfaces). Its "What the harness needs" section is your work order.
2. `tools/browser-harness/` in full: `smoke.mts`, `page-queries.mts`, `server-routes.mts`,
   `fixtures.mts`, `turn-fixture.mts`, `README.md`.
3. `/tmp/cf-stumble-v0-handoff-2026-09-08.md`, "The demo that defines done".
4. `~/.agents/skills/poteto-mode/SKILL.md` and the `control-ui` skill. Work in that style.

## What to build

The shared half of the harness, plus one surface as the worked example. Five other agents will each
add one surface module afterwards, so the contract you publish is the thing they build against.
That makes the contract the deliverable, not an afternote.

1. A runner: `tools/browser-harness/run.mts`, wired to `pnpm harness:browser`. It starts the stub
   owner API, serves the real page, attaches to Chromium over CDP, runs every registered case in
   isolation, collects console errors, uncaught exceptions and CSP violations per case, enforces a
   per-case timeout, and prints one line per case plus a final summary with a non-zero exit code on
   any failure. Keep the existing fast smoke check reachable, for example
   `pnpm harness:browser --only smoke`.
2. A case contract. Decide the shape from the case list, then write it down in
   `tools/browser-harness/CASES.md`: the module layout, the exported type, what a case receives,
   every helper it may call with its exact signature, how a case names the stub scenario it needs,
   and a complete worked example. Another agent must be able to write a passing case from that
   document alone without reading your driver.
3. The page helpers the case list needs: navigation, evaluation in the page, text and attribute
   reads, accessible-name lookup, click, keyboard including Tab and Shift-Tab, focus order,
   element rectangles, overflow and scroll checks, viewport size, and waiting for a streamed frame
   to appear.
4. A controllable stub owner API: named scenarios, a barrier that holds a stream open until the
   case releases it, a stream that closes with no terminal frame, generation states for submit,
   activate, rollback, stale epoch and a failing startup check, per-project threads, an empty
   project list, and the fixture data each surface needs. Read the case list for the exact set.
   The stub serves the real page and the real API shapes; it may not fake page behavior.
5. The chat-stream surface, `CHAT-1` to `CHAT-14`, as the worked example. Every case that the list
   marks `must` has to pass or be reported as a product defect with evidence.

## Rules

- The harness is test tooling, not product code. Do not change `src/`. If a case exposes a product
  defect, do not fix the product: report it with the case id, what you observed, and where the
  page does it.
- No narrating comments. Assertion messages carry the meaning.
- This runs outside the commit gate, so it may take a minute. Keep the smoke path fast.
- Wrap every long command in `timeout`, redirect output to a file, and never leave a foreground
  server or browser running without one. `export CF_STUMBLE_CHROME="$(command -v chromium)"` first.

## The gate

`pnpm verify` green before every commit; the pre-commit hook runs it. `pnpm format` fixes
formatting. Run `timeout 600 pnpm harness:browser > /tmp/harness-runner.log 2>&1` and report the
summary. Rebase on `origin/main` before you push, then verify again. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/harness-runner`.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 500 words: the
case contract in enough detail that five agents can start from your reply alone, branch and SHAs,
the harness summary line, every chat case that failed with the product defect behind it, and what
the next five agents must not touch to avoid conflicting with each other.
