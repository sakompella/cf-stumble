# cf-stumble

## Agent skills

### Issue tracker

Issues live as GitHub issues in `sakompella/cf-stumble`, managed with the `gh` CLI; all write operations need explicit developer approval. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Writing documentation

When you create or edit prose documentation, read `docs/agents/writing-style.md` and follow its plain technical English guidance.

### Verification

Run `pnpm verify` before you claim anything works. It runs typecheck, format check, lint and the full test suite in that order, in about eleven seconds. The order matters: type errors make the type-aware lint rules report noise about `error` types instead of the real fault, and formatting changes what lint sees, since wrapping a long line has pushed a file over `max-lines` here before.

A tracked `.githooks/pre-commit` runs the same command and blocks the commit when it fails. `pnpm format` fixes formatting; nothing else in the gate is auto-fixable.

### Project architecture

For architecture, planning, or implementation work, read `docs/agents/domain.md` before exploring. It gives the required reading order for the product overview, glossary, current ADRs, implementation plan, and Computer evidence. Everything under `docs/agents/` is agent-generated; `README.md` is reserved for human-written project documentation and agents must not change it unless the user explicitly directs the content.
