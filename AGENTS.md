# cf-stumble

## Agent skills

### Issue tracker

Issues live as GitHub issues in `sakompella/cf-stumble`, managed with the `gh` CLI; all write operations need explicit developer approval. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Writing documentation

When you create or edit prose documentation, read `docs/agents/writing-style.md` and follow its plain technical English guidance.

### Verification

Run `nix develop -c pnpm verify` before you claim anything works. `flake.nix` pins the whole environment (Node 22, pnpm, dash, bash, GNU coreutils, git, jq, perl, findutils, gnused, gnugrep, gawk), so the shell tests run the same on Linux and macOS; they fail with a message when run outside it, so use `nix develop -c` for every `pnpm` command that runs tests. `pnpm verify` runs `verify:project-protocol`, `build:page`, typecheck, tools typecheck (both run `tsrs --noEmit`, the Rust port of the TypeScript compiler; the repo has no `typescript` package, and `tsrs` exits 2 on a type error where `tsc` exited 1), format check, `knip`, lint, `test:tools`, `build:module-map`, `build:shell-modules`, `build:loaded-execution-env-fixture`, and the full test suite in that order. `build:shell-modules` writes the ignored `build/shell-assets/shell-modules.json`, the module set of the isolate shell; it ships as a static asset (the `ASSETS` binding) and the Worker loads it into a Dynamic Worker, so it stays out of the Worker bundle. `test:tools` runs the tests under `tools/` (the vendored lint rules, the Foldkit lint rule decisions, the bundle budgets, the Worker startup check, and `ops:check`) with `node --test`, because Vitest only collects `test/`. It takes about 90 seconds on the Mac. The Worker startup check (`tools/worker-startup.test.ts`) builds the bundle that Alchemy uploads (`infra/worker-bundle.ts`) and starts it in Miniflare with the production compatibility settings, so a Worker that cannot start fails before merge, not at the deploy's upload (the 2caaafcb `FinalizationRegistry` deploy failure). See `docs/deploy.md`, "Configuration files". `build:page` writes the ignored module that holds the owner page's script, so on a fresh checkout run it before `pnpm typecheck` or `pnpm test` alone. `knip` fails on any export under `src/` that production code never imports, and on any `src/` file production never reaches. Production is `src/worker.ts`, the page entry, the generation-1 facet entry, and the `tools/` scripts that `package.json` runs. A test that imports an export does not count. When a test exercises real logic through an export, add that file to `ignoreIssues` in `knip.json` with the issue type it needs (`exports` or `types`); otherwise delete the export or the re-export. The order matters: type errors make the type-aware lint rules report noise about `error` types instead of the real fault, and formatting changes what lint sees, since wrapping a long line has pushed a file over `max-lines` here before.

After a staging deploy or an e2e run, run `pnpm ops:check` (see `docs/agents/design/observability.md`, "Checking a running deployment") before you claim it works. `pnpm verify` cannot see runtime faults such as an idle container that keeps running. Run `pnpm e2e` (`docs/deploy.md`, "End-to-end run") before you merge a risky change to the Worker, the Supervisor, the Workspace Host or the facet; it deploys a throwaway stage, costs container time and model calls, and is not part of `pnpm verify`. When the machine is busy, a test can exceed Vitest's default 5 s timeout; run that test again alone before you suspect your change.

CI runs the full gate on Ubuntu: `.github/workflows/verify.yml` installs Nix and runs `nix develop -c pnpm verify` on every push and pull request. A tracked `.githooks/pre-commit` runs the same command and blocks the commit when it fails. `pnpm format` fixes formatting; nothing else in the gate is auto-fixable.

`pnpm test:mutation` runs StrykerJS mutation testing on the pure modules listed under `mutate` in `stryker.config.json`: the Supervisor state machines, exec routing and input parsing, the isolate Git status and rename code, redaction and the model route stream parser. Stryker cannot run tests in the Workers pool, so `vitest.mutation.config.ts` runs only the Node-project tests (`*.props.test.ts` and `*.shell.test.ts`); a module you add to `mutate` must be importable under Node and covered by a Node-project test. `tsconfigFile` is empty because Stryker otherwise parses `tsconfig.json` with the `typescript` package, which the repository does not install. The run takes about four minutes and writes `build/mutation/index.html`. It is not part of `pnpm verify`; run it (`nix develop -c pnpm test:mutation`) after you change one of those modules or its tests, and read the surviving mutants. Pass `--mutate <file>` to check one module.

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

`infra/alchemy.run.ts`, an Alchemy stack, is the only description of the Worker. It builds from the values in `infra/worker-settings.ts`, which `infra/test-worker.ts` and the Worker code also read, so change a shared value there. Keep that file free of `node:` imports, because the Worker bundle includes it. There is no `cloudflare.config.ts` and no Wrangler config. Vitest runs the Worker `cf-stumble-test` from the Miniflare options in `infra/test-worker.ts` (no `AI` binding, no container) and adds `OWNER_PASSWORD`. `pnpm run deploy [<stage>] [flags]` (`infra/deploy.sh`) is the deploy path for every stage: it runs `install:infra`, `build:page` and `build:shell-modules`, then deploys the stage, `prod` (production) when none is named, and passes the flags to `alchemy deploy`. CI runs it too. Any other stage is a separate Worker named `cf-stumble-<stage>`, so a staging copy is `pnpm run deploy <stage>`. Run Alchemy from the repository root through `pnpm alchemy ... --config infra/alchemy.run.ts`, never by hand-written paths. `infra/` is its own pnpm project with its own lockfile; `pnpm install:infra` installs it. The repository has no local dev server script: `alchemy dev` needs the production state store, so check the page with `pnpm test:browser` and everything else on a staging stage. Alchemy's state lives in the account's `alchemy-state-store` Worker (ADR-0049). Never delete that Worker, and deploy with `--force` after anything changed the Worker outside Alchemy. `cf` stays for what needs no configuration file: secrets (`cf workers secrets`), container applications, images, deployment lists, and auth; run it as `pnpm exec cf` under Node. `pnpm alchemy logs --config infra/alchemy.run.ts --stage prod --tail` streams the Worker's logs. The repository does not declare `wrangler`. Per-instance values (`OWNER_PASSWORD`, `HARNESS_REPOSITORY_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GH_TOKEN`) are Worker secrets that the stack never declares; an Alchemy deploy keeps them. See `docs/deploy.md`.

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
