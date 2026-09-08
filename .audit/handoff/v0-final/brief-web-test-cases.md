# Brief: write end-to-end web test cases for the cf-stumble owner page

Two agents run this brief independently, one on `anthropic/claude-opus-5` and one on
`openai-codex/gpt-5.6-sol`. Do not read the other's output. The orchestrator merges and
deduplicates both sets, so overlap is expected and fine.

## Read

1. `/tmp/cf-stumble-v0-handoff-2026-09-08.md`, especially "The demo that defines done".
2. `/home/aditya/repos/cf-stumble/.audit/v0/realignment-notes.md`.
3. The page source: `/home/aditya/repos/cf-stumble/src/page/` and `src/routes/page.ts`.
4. The existing browser harness: `/home/aditya/repos/cf-stumble/tools/browser-harness/`
   (entrypoint `smoke.mts`; it starts a stub owner API, serves the real page and drives headless
   Chromium over CDP).

Note the current state of the tree: the recovery report panel, the turn-credit field and the
eligibility surface were deleted on `main` today, so no case may assert them.

## What to produce

A file of executable-by-an-agent test cases, one section per surface:

1. Chat stream.
2. Generation drawer (submit, activate, rollback, epoch).
3. Project sidebar (the one connected project plus the harness entry).
4. Keyboard access.
5. Narrow viewport.
6. Wide viewport.

Each case gets: an id (`CHAT-1`, `GEN-3`, ...), one sentence of intent, preconditions, the exact
steps a CDP-driving agent takes, the observable assertion, and how it fails. Assert observable
behavior, never an implementation detail: no internal element id unless the page's own contract
depends on it, and no assertion that passes when the page renders nothing. Prefer a case that
would fail if the page silently stopped streaming.

Include the negative and edge cases that matter for this product: a candidate that fails its
startup check while the active generation keeps serving, a stale epoch rejected, an empty project
list, a turn that ends without a diff, a long single-line command output, and focus order with no
mouse.

Keep it to at most 40 cases. Rank each `must` or `should`. Say plainly which cases the current
harness already covers and which need new driving code.

## Where to write it

`/home/aditya/repos/cf-stumble/.audit/v0/web-test-cases-<your-model-family>.md`, where the family
is `opus` for `anthropic/claude-opus-5` and `sol` for `openai-codex/gpt-5.6-sol`. That directory is
gitignored; do not commit. Do not touch anything else in the repository.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) with the file path,
the case count per surface, and the three cases you think are most likely to catch a real defect.
Under 300 words.
