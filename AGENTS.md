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

A tracked `.githooks/pre-commit` runs the same command and blocks the commit when it fails. `pnpm format` fixes formatting; nothing else in the gate is auto-fixable.

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

Deploying with `cf deploy`, checking a deployment or runtime with `pnpm ops:check`, staging a risky change, and diagnosing container cost or idle stops: use the `cf-operations` skill (`.agents/skills/cf-operations/SKILL.md`). `docs/deploy.md` is the human runbook.

### Cloudflare CLI and configuration

`cloudflare.config.ts` is the only Worker configuration, and `cf deploy` is the deploy path. It is a function of the mode: Vitest evaluates it with mode `test`, which names the Worker `cf-stumble-test` and drops the `AI` binding, and a plain `cf deploy` leaves the mode undefined and gets production. Never deploy with `--mode test`. Run `cf` through `pnpm exec cf`, under Node: it cannot load the config on Bun. `cf build` and `cf deploy` delegate to the `wrangler` dev dependency, which `cf` requires, and `wrangler.config.ts` holds the one thing `cloudflare.config.ts` has no field for: the `build.command` that writes the owner page's script before bundling. Keep it. `scripts/local/dev.sh` runs `cf dev`, and secrets use `cf workers secrets`. `wrangler tail` stays on Wrangler, and so does the bundle size check in `tools/bundle-budgets.test.ts` (`wrangler deploy --dry-run --experimental-new-config`), because `cf build` also builds the Container image and needs Docker. `cf` has no `--config` flag, so a staging copy needs its own directory. Per-instance values (`HARNESS_REPOSITORY_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GH_TOKEN`) are Worker secrets that no config file declares, because `cf deploy` drops undeclared plain-text variables and a declared secret is required; never pass `--var` to it. See `docs/deploy.md`.

### Browser harness

`pnpm verify` never opens a browser, so it cannot see that the owner page fills itself in. `pnpm test:browser` does: Playwright specs in `tools/playwright` drive the real page against a local stub of the owner API (`tools/browser-harness`) and cover the streamed turn, cancel, reload persistence, the project sidebar, GitHub states, the generation drawer, and a phone viewport. It needs Chromium and stays outside the commit gate; set `CHROMIUM_PATH` to an executable when Playwright's own download does not run, as on NixOS.

### Scope

Earlier agents on this repository built far past what Aditya asked (see the Oct 2026 forensics in `.audit/opus-overhaul-2026-10-30/forensics.md` on his machines). Before you build:

- Do the plain request first. If you choose a heavier option than the one he named, say so before you build it.
- Guard only against failures that have happened. Name the incident in the commit message.
- One writer pass and one review pass. Fold review nits into the same commit.
- Keep plans, evidence, and decision logs in `.audit/` or `_*.md`; never commit them.
- Prove a change on the deployed instance or a staging copy, not only against fakes.

### Project architecture

For architecture, planning, or implementation work, read `docs/agents/domain.md` before exploring. It gives the required reading order for the product overview, glossary, current ADRs, Computer integration, and current status. Everything under `docs/agents/` is agent-generated. Never change the content of `README.md` unless Aditya asks. If it only needs reformatting to pass `pnpm format:check`, reformat it in a commit of its own.
