# cf-stumble

## Agent skills

### Issue tracker

Issues live as GitHub issues in `sakompella/cf-stumble`, managed with the `gh` CLI; all write operations need explicit developer approval. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Writing documentation

When you create or edit prose documentation, read `docs/agents/writing-style.md` and follow its plain technical English guidance.

### Verification

Run `pnpm verify` before you claim anything works. It runs `build:pi`, `verify:vendor`, `verify:project-protocol`, `build:page`, typecheck, tools typecheck, format check, lint, `test:tools`, `build:module-map`, `build:loaded-execution-env-fixture`, and the full test suite in that order. `test:tools` runs the tests under `tools/` (the vendored lint rules, the Foldkit lint rule decisions, the bundle budgets, and `ops:check`) with `node --test`, because Vitest only collects `test/`. It takes about 90 seconds on the Mac. `build:page` writes the ignored module that holds the owner page's script, so on a fresh checkout run it before `pnpm typecheck` or `pnpm test` alone. The order matters: type errors make the type-aware lint rules report noise about `error` types instead of the real fault, and formatting changes what lint sees, since wrapping a long line has pushed a file over `max-lines` here before.

After a staging deploy or an e2e run, run `pnpm ops:check` (see `docs/agents/design/observability.md`, "Checking a running deployment") before you claim it works. `pnpm verify` cannot see runtime faults such as a poller or an idle container that keeps running. When the machine is busy, a test can exceed Vitest's default 5 s timeout; run that test again alone before you suspect your change.

A tracked `.githooks/pre-commit` runs the same command and blocks the commit when it fails. `pnpm format` fixes formatting; nothing else in the gate is auto-fixable.

### Cloudflare operations

Deploying with `cf deploy`, checking a deployment or runtime with `pnpm ops:check`, staging a risky change, and diagnosing container cost or idle stops: use the `cf-operations` skill (`.agents/skills/cf-operations/SKILL.md`). `docs/deploy.md` is the human runbook.

### Cloudflare CLI and configuration

`cloudflare.config.ts` is the source of truth for the Worker, and `cf deploy` is the deploy path. Run `cf` through `pnpm exec cf`, under Node: it cannot load the config on Bun. `wrangler.jsonc` (Deploy to Cloudflare and `wrangler deploy`) and `wrangler.test.jsonc` (vitest) repeat the config, and `test/docs/cloudflare-config-drift.test.ts` fails when they drift. `cf dev` fails here, so `wrangler tail`, `wrangler secret put`, and `scripts/local/dev.sh` use Wrangler. `cf` has no `--config` flag, so a staging copy needs its own directory. Never alternate `wrangler deploy` and `cf deploy` on one Worker. Per-instance values (`CF_ACCESS_*`, `HARNESS_REPOSITORY_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GH_TOKEN`) are Worker secrets that no config file declares, because `cf deploy` drops undeclared plain-text variables and a declared secret is required; never pass `--var` to it. See `docs/deploy.md`.

### Browser harness

`pnpm verify` never opens a browser, so it cannot see that the owner page fills itself in. `pnpm harness:browser` does: it starts a local stub of the owner API, serves the real page, drives headless Chromium over the DevTools protocol, and asserts the streaming conversation, the project sidebar, the generation drawer, keyboard access, and narrow and wide viewports. It needs a local Chromium and about a minute, so it stays outside the commit gate. Read `tools/browser-harness/README.md` before you change the page. The harness proves nothing about Cloudflare Access, which needs a deployed environment.

### Project architecture

For architecture, planning, or implementation work, read `docs/agents/domain.md` before exploring. It gives the required reading order for the product overview, glossary, current ADRs, Computer integration, and current status. Everything under `docs/agents/` is agent-generated. Agents must never edit `README.md`, including to fix formatting or a failing check. Tell the owner when it needs a change.
