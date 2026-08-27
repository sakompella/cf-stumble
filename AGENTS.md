# cf-stumble

## Agent skills

### Issue tracker

Issues live as GitHub issues in `sakompella/cf-stumble`, managed with the `gh` CLI; all write operations need explicit developer approval. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root and one ADR directory at `docs/agents/adr/`, both read before exploring. Everything under `docs/agents/` is agent-generated; `docs/` outside it is reserved for hand-written human documentation. See `docs/agents/domain.md`.
