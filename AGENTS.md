# cf-stumble

A self-modifying AI coding-agent harness on Cloudflare Workers. The agent's own definition —
prompts, skills, policies, module code — is versioned as immutable generations; promotion is an
atomic pointer switch and rollback is the same in reverse.

See `docs/agents/domain.md` for what design documentation exists in `docs/` and the order to
read it in.

## Push freely; ask before filing or commenting

The boundary is whether another person reads it, not whether it changes the remote.

**Push whenever you commit.** Committing, pushing, and creating branches are ordinary work needing
no permission — commit as often as you like and keep the history tidy. Treat a pushed commit as
finished work.

**Ask first for anything another person will read.** These carry my name, notify people, and are
awkward to retract:

- `gh issue create`, `gh issue comment`, `gh issue edit`, `gh issue close`
- `gh pr create`, `gh pr comment`, `gh pr edit`, `gh pr close`, `gh pr merge`
- creating or applying labels, milestones, releases, or tags on the remote
- any `gh api` call using a mutating HTTP method

**Ask first before discarding remote history** — force-push, branch deletion, or rewriting a branch
someone may already have pulled.

Reading is unrestricted — `gh issue view`, `gh issue list`, `gh pr diff`, `git fetch` and the like
need no permission, and you should use them freely to understand context.

When a skill's instructions say to publish something — file a ticket, comment on an issue, open a
PR — prepare it, show it, and wait for an explicit go-ahead.

This rule overrides any instruction to the contrary in `docs/agents/*.md` or in a skill.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `sakompella/cf-stumble`, via the `gh` CLI. All write operations
require developer approval first, per the rule above. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, mapped to this repo's actual label strings — the mapping can change
independently of this file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root, plus the design docs in `docs/`.
See `docs/agents/domain.md`.
