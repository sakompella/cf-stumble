# Brief: rewrite the v0 plan documents (handoff decision 12)

You are the prose and documentation role for the cf-stumble v0 finishing run. Model
`openai-codex/gpt-5.6-terra`.

## Where to work

Worktree: `/home/aditya/wt/plan-docs`, branch `work/plan-docs`, based on `main` at `e769586`.
Do every edit there. Never touch `/home/aditya/repos/cf-stumble` (another agent is working in it).

## Read first, in this order

1. `/tmp/cf-stumble-v0-handoff-2026-09-08.md` in full. Its "Owner execution directives" section
   is the highest authority. Decision 12 is your task.
2. `/home/aditya/wt/plan-docs/AGENTS.md` and `docs/agents/domain.md`.
3. `docs/agents/writing-style.md`, then the `writing-for-agents` skill.
4. `docs/agents/design/feature-map.md` (the document you rewrite), `docs/agents/design/overview.md`,
   `docs/agents/design/computer-integration.md`, `docs/agents/design/v0-work-record.md`.
5. `.audit/v0/goal.md` (gitignored, present in the main worktree at
   `/home/aditya/repos/cf-stumble/.audit/v0/goal.md`; the worktree does not have `.audit/`).
6. `/tmp/cf-stumble-realignment-session-2026-09-08.md` only if a handoff decision reads ambiguous.

## What to produce

1. Rewrite `docs/agents/design/feature-map.md` as a plain ordered checklist of what v0 still needs
   and what its cut line is. Delete the P0-P4 phase structure and every T-number. Keep the
   "not part of this release" and "deliberately postponed" content, since the handoff says those
   lists stay valid. Fold in the handoff's seven demo steps, its deletion rule, and the decisions
   that supersede the old criteria: one connected project not two, the harness is itself a project
   in the sidebar, one session per project, R2 cut from v0, recovery/eligibility/turn-credit
   deleted with the turn lease kept, the release-gate cuts in decision 10, and the reframe in
   decision 1 (v0 is a public-able repo with a deploy-to-your-own-account feature, with a
   "Deploy to Cloudflare" button as the front door).
2. State the harness self-edit path in that document, in the handoff's terms: `/workspace/harness`
   is a real Git clone, the agent edits and commits there with ordinary git, candidate submission
   names that commit SHA, the build runs `git archive` from the harness repository into
   `/workspace/.builds/<commit>`, and the harness-as-project sidebar entry is only a
   working-directory selection.
3. Also state the fresh-account bootstrap sequence from the handoff, as an ordered list, including
   that the Worker fails closed with `CF_ACCESS_*` unset or partial.
4. Rewrite `/home/aditya/repos/cf-stumble/.audit/v0/goal.md` (edit that path directly; it is
   gitignored and not in your worktree) as a plain ordered checklist with the cut criteria
   removed. Cut criterion 3's "at least two GitHub repositories", criterion 5's forced-compaction
   test, criterion 7's R2 and double-build requirements, criterion 9's paid restart, shared
   container and credential-reconnect evidence, and criterion 2's cross-tenant claim. Keep the
   old numbering nowhere; this is a plain checklist now.
5. Add a one-line supersession notice at the top of every tracked document that still directs an
   agent toward removed behavior. At minimum `docs/agents/adr/0034-cache-rebuildable-module-maps-in-r2.md`,
   and check `0031-relay-facts-decide-known-good.md` and
   `0032-recovery-bounds-an-episode-it-does-not-perform.md` against handoff decisions 6 and 7.
   Word each notice so it says the decision no longer applies to v0 and names the handoff decision
   number. Do NOT delete those ADRs and do NOT edit `docs/agents/adr/README.md`; the code-deletion
   commits remove them, and `test/docs/adr-index.test.ts` checks the index.
6. Update `docs/agents/domain.md`'s reading list only if a sentence there now points at something
   you renamed or removed. Keep the edit minimal.

## Rules

- Documentation only. No `src/`, no `test/`, no `wrangler.jsonc`.
- Do not edit `README.md`. AGENTS.md reserves it for the human.
- No jargon the handoff dropped: no phase numbers, no T-numbers, no "wave", no "tier".
- Run the `writing-for-agents` skill, then `humanizer`, then `unslop` over every document you
  wrote or edited, in that order, and say in your report what each pass changed.
- Plain technical English. Short sentences. No long-dash character. No colon as a mid-sentence
  connector.
- Run `pnpm verify` in your worktree before you commit. It is the gate and takes about a minute.
  Never commit through a red gate.
- Commit on `work/plan-docs` with a message in this repository's style (lowercase type, scope,
  imperative subject; look at `git log` for examples). Then push:
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/plan-docs`
- Do not merge to `main`. The orchestrator merges.

## Report

When finished, reply to your parent with `await agent_message.send(..., receiver_role='parent')`:
the branch and commit SHA, the files you changed, what each skill pass changed, the `pnpm verify`
result line, and anything in the handoff you could not reconcile. Keep it under 400 words.
