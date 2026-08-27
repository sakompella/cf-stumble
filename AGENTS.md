# cf-stumble

## Agent skills

### Issue tracker

Issues live as GitHub issues in `sakompella/cf-stumble`, managed with the `gh` CLI; all write operations need explicit developer approval. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context, and both paths differ from the skill defaults: the glossary is `docs/agents/CONTEXT.md`, not `CONTEXT.md` at the repo root, and the ADRs are in `docs/agents/adr/`, not `docs/adr/`. Read both before exploring. Everything under `docs/agents/` is agent-generated; `docs/` outside it is reserved for hand-written human documentation. See `docs/agents/domain.md`.
