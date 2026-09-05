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

### Browser harness

`pnpm verify` never opens a browser, so it cannot see that the owner page fills itself in. `pnpm harness:browser` does: it starts a local stub of the owner API, serves the real page, drives headless Chromium over the DevTools protocol, and asserts the streaming conversation, the project sidebar, the generation drawer, keyboard access, and narrow and wide viewports. It needs a local Chromium and about a minute, so it stays outside the commit gate. Read `tools/browser-harness/README.md` before you change the page. The harness proves nothing about Cloudflare Access, which needs a deployed environment.

### Project architecture

For architecture, planning, or implementation work, read `docs/agents/domain.md` before exploring. It gives the required reading order for the product overview, glossary, current ADRs, implementation plan, and Computer evidence. Everything under `docs/agents/` is agent-generated; `README.md` is reserved for human-written project documentation and agents must not change it unless the user explicitly directs the content.
