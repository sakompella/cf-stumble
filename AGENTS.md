# cf-stumble

## Agent skills

### Issue tracker

Issues live as GitHub issues in `sakompella/cf-stumble`, managed with the `gh` CLI; all write operations need explicit developer approval. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Writing documentation

When you create or edit prose documentation, read `docs/agents/writing-style.md` and follow its plain technical English guidance.

### Verification

Run `pnpm verify` before you claim anything works. It runs `verify:project-protocol`, `build:page`, typecheck, tools typecheck (both run `tsrs --noEmit`, the Rust port of the TypeScript compiler; the repo has no `typescript` package, and `tsrs` exits 2 on a type error where `tsc` exited 1), format check, `knip`, lint, `test:tools`, `build:module-map`, `build:loaded-execution-env-fixture`, and the full test suite in that order. `test:tools` runs the tests under `tools/` (the vendored lint rules, the Foldkit lint rule decisions, the bundle budgets, and `ops:check`) with `node --test`, because Vitest only collects `test/`. It takes about 90 seconds on the Mac. `build:page` writes the ignored module that holds the owner page's script, so on a fresh checkout run it before `pnpm typecheck` or `pnpm test` alone. `knip` fails on any export under `src/` that production code never imports, and on any `src/` file production never reaches. Production is `src/worker.ts`, the page entry, the generation-1 facet entry, and the `tools/` scripts that `package.json` runs. A test that imports an export does not count. When a test exercises real logic through an export, add that file to `ignoreIssues` in `knip.json` with the issue type it needs (`exports` or `types`); otherwise delete the export or the re-export. The order matters: type errors make the type-aware lint rules report noise about `error` types instead of the real fault, and formatting changes what lint sees, since wrapping a long line has pushed a file over `max-lines` here before.

After a staging deploy or an e2e run, run `pnpm ops:check` (see `docs/agents/design/observability.md`, "Checking a running deployment") before you claim it works. `pnpm verify` cannot see runtime faults such as an idle container that keeps running. When the machine is busy, a test can exceed Vitest's default 5 s timeout; run that test again alone before you suspect your change.

CI runs the full gate on Ubuntu: `.github/workflows/verify.yml` runs `pnpm verify` on every push and pull request. A tracked `.githooks/pre-commit` runs the same command and blocks the commit when it fails. `pnpm format` fixes formatting; nothing else in the gate is auto-fixable.

### Editor setup

The repo has no editor config. `pnpm typecheck` and `pnpm typecheck:tools` run `tsrs`, so point the editor at the same checker or it will disagree with `pnpm verify`. The language server is `pnpm exec tsrs --lsp -stdio`. In VS Code, install the TypeScript 7 extension (`TypeScriptTeam.native-preview`) and set this in your user or workspace settings (from tsrs's `docs/LSP.md`; use the `tsrs` version in `package.json`), then run "TypeScript 7: Restart Server":

```jsonc
{
  "js/ts.experimental.useTsgo": true,
  "js/ts.tsdk.path": "./node_modules/tsrs/tsdk",
}
```

Other editors run `tsrs --lsp -stdio` as an LSP server for TypeScript files, and should turn off other TypeScript servers. The server passes 4,092 of 4,562 upstream editor-feature test groups, so a missing hover or fix is not proof of a type error: trust `pnpm typecheck`.

### Cloudflare operations

Deploying with Alchemy (a push to `main`, which deploys through GitHub Actions, or `pnpm run deploy`), checking a deployment or runtime with `pnpm ops:check`, staging a risky change, and diagnosing container cost or idle stops: use the `cf-operations` skill (`.agents/skills/cf-operations/SKILL.md`). `docs/deploy.md` is the human runbook.

### Alchemy, Cloudflare CLI and configuration

`infra/alchemy.run.ts`, an Alchemy stack, is the only Worker configuration, and `pnpm run deploy` is the deploy path: it runs `build:page` and deploys the stage `prod`, which is production. Any other stage is a separate Worker named `cf-stumble-<stage>`, so a staging copy is `pnpm alchemy deploy --config infra/alchemy.run.ts --stage <stage>` after `pnpm run build:page`. Run Alchemy from the repository root through `pnpm alchemy ... --config infra/alchemy.run.ts`, never by hand-written paths. `infra/` is its own pnpm project with its own lockfile, because Alchemy needs Effect 4.0 while the Worker uses 4.1, and the Container image copies the root lockfile; `pnpm install:infra` installs it. Vitest builds its Miniflare options from `infra/worker-settings.ts` (Worker `cf-stumble-test`, no `AI` binding). Alchemy's state lives in the account's `alchemy-state-store` Worker (ADR-0049); never delete it, and deploy with `--force` after anything changed the Worker outside Alchemy. `cf` stays for secrets (`cf workers secrets`), container applications, images, and deployment lists; run it as `pnpm exec cf` under Node. `wrangler` stays for `wrangler tail`, the bundle size check in `tools/bundle-budgets.test.ts`, and the test runner. Per-instance values (`OWNER_PASSWORD`, `HARNESS_REPOSITORY_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GH_TOKEN`) are Worker secrets that the stack never declares; an Alchemy deploy keeps them. There is no local dev server script; `alchemy dev` is untested here. See `docs/deploy.md`.

### Browser harness

`pnpm verify` never opens a browser, so it cannot see that the owner page fills itself in. To look at the page yourself, use the `chrome-devtools` MCP server first: open the page served by a staging copy (the repository has no local dev server script), then read its snapshot, console messages and network requests. The page needs Basic auth. Set an `Authorization: Basic <base64 of aditya:password>` header with the server's `emulate` tool (`extraHttpHeaders`) and open the plain URL. Do not put the credentials in the URL: the page loads, but its own `fetch` calls fail because Chrome refuses a request whose URL includes credentials. Use Playwright when that server is not available.

`pnpm test:browser` checks the page in a browser: Playwright specs in `tools/playwright` drive the real page against a local stub of the owner API (`tools/browser-harness`, which checks a fixed Basic credential that the Playwright config sends) and cover the streamed turn, cancel, reload persistence, the project sidebar, GitHub states, and a phone viewport. It needs Chromium and stays outside the commit gate; set `CHROMIUM_PATH` to an executable when Playwright's own download does not run, as on NixOS.

### Scope

Earlier agents on this repository built far past what Aditya asked (see the Oct 2026 forensics in `.audit/opus-overhaul-2026-10-30/forensics.md` on his machines). Before you build:

- Do the plain request first. If you choose a heavier option than the one he named, say so before you build it.
- Guard only against failures that have happened. Name the incident in the commit message.
- One writer pass and one review pass. Fold review nits into the same commit.
- Keep plans, evidence, and decision logs in `.audit/` or `_*.md`; never commit them.
- Prove a change on the deployed instance or a staging copy, not only against fakes.

### Project architecture

For architecture, planning, or implementation work, read `docs/agents/domain.md` before exploring. It gives the required reading order for the product overview, glossary, current ADRs, Computer integration, and current status. Everything under `docs/agents/` is agent-generated. Never change the content of `README.md` unless Aditya asks. If it only needs reformatting to pass `pnpm format:check`, reformat it in a commit of its own.
