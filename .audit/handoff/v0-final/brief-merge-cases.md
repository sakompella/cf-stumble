# Brief: merge and deduplicate the two web test case sets

You are the judgment role (`openai-codex/gpt-5.6-sol`). Read-only on tracked files.

## Inputs

- `/home/aditya/repos/cf-stumble/.audit/v0/web-test-cases-opus.md` (39 cases)
- `/home/aditya/repos/cf-stumble/.audit/v0/web-test-cases-sol.md` (33 cases)

They were written independently against the same brief
(`.audit/handoff/v0-final/brief-web-test-cases.md`). One of them is your own earlier output; treat
both as equal input and judge on merit.

## Output

Write `/home/aditya/repos/cf-stumble/.audit/v0/web-test-cases.md`, the merged list the executing
agents will work from. Rules:

- One case per behavior. When both sets cover the same behavior, keep the stronger assertion and
  say in one clause why. When they disagree about expected behavior, keep both and mark the
  conflict.
- Renumber into one id space per surface (`CHAT-n`, `GEN-n`, `SIDE-n`, `KEY-n`, `NAR-n`, `WID-n`).
  Add a `source` field naming `opus`, `sol` or `both`.
- Keep intent, preconditions, steps, the observable assertion, and the failure mode for every
  case. Drop nothing a driver needs.
- Rank `must` or `should`. A `must` is a case the seven demo steps or the owner's stated evidence
  depend on.
- Drop or rewrite any case that asserts code deleted today: the recovery report panel, turn credit,
  eligibility, relay attempts, or the R2 cache.
- Note where the two authors disagreed about the current tree (for example whether the sidebar has
  a harness entry today; a worker is adding one right now on `work/harness-project`).

Then add two short sections at the top:

1. **Index.** A table of surface, case ids, must count, should count.
2. **What the harness needs.** The shared driving code and fixtures the cases require that
   `tools/browser-harness/` does not have yet, as a list of concrete pieces, ordered so one agent
   can build the shared part before six agents write one surface each. Name the fixture data each
   surface needs from the stub owner API. Read `tools/browser-harness/smoke.mts`,
   `page-queries.mts`, `server-routes.mts`, `fixtures.mts` and `README.md` before you write this
   section.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) with the index
table, the merged total, every conflict you kept, and the ordered list from "What the harness
needs". Under 500 words. This is the part the orchestrator acts on, so make it complete enough to
brief six workers from.
