# cf-stumble

## Agent skills

### Issue tracker

Issues live in GitHub issues on `sakompella/cf-stumble` and are managed with `gh`; every GitHub write needs Aditya's explicit OK first. See `docs/agents/issue-tracker.md`.

### Triage labels

The five triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single context, kept under `docs/agents/` rather than the repo root. Before architecture, planning or implementation work, read `docs/agents/domain.md`: it gives the reading order.

### Writing documentation

Before you write or edit prose docs, read `docs/agents/writing-style.md`.

## Scope

Earlier agents here built far past what Aditya asked (Oct 2026 forensics: `.audit/opus-overhaul-2026-10-30/forensics.md` on his machines). So:

- Do the plain request first. If you pick a heavier option than the one he named, say so before you build it.
- Guard only against failures that have happened, and name the incident in the commit message.
- One writer pass, one review pass. Fold review nits into the same commit.
- Keep plans, evidence and decision logs in `.audit/` or `_*.md` (globally gitignored); never commit them.
- Prove a change on the deployed instance or a staging copy, not only against fakes.
- Get Aditya's explicit OK before any `git push`, to any branch or remote.
- Leave the content of `README.md` alone unless Aditya asks. If it only needs reformatting for `pnpm format:check`, do that in a commit of its own.

## Verification

Run every `pnpm` command that builds or tests inside `nix develop -c`: `flake.nix` pins Node, pnpm and the shell tools, and the shell tests refuse to run outside it.

- `nix develop -c pnpm verify` is the gate. Run it before you claim anything works. CI (`.github/workflows/verify.yml`) runs the same command. Only formatting is auto-fixable: `pnpm format`.
- On a fresh checkout, run `pnpm build:page` before `pnpm typecheck` or `pnpm test` on their own: it writes the ignored module that holds the owner page script.
- Typechecking uses `tsrs`, the Rust port of the TypeScript compiler; the repo has no `typescript` package. `tsrs` exits 2 on a type error.
- `pnpm lint:effect` runs the Effect language service (`effect-tsgo tsrs`) and fails on any Effect diagnostic. Its rules are under `plugins` in `tsconfig.json`. Fix a hit at its cause: the repo forbids comments, so `@effect-diagnostics` directives are not an option.
- `knip --production` fails on any `src/` or `tools/` export or file that production code never reaches. A test import does not count. When a test exercises real logic through an export, add the file to `knip.ignoreIssues` in `package.json` with the issue type (`exports` or `types`); otherwise delete the export.
- `tools/worker-startup.test.ts` builds the bundle Alchemy uploads and starts it in Miniflare, so a Worker that cannot start fails before merge.
- `test/runtime-parity.test.ts` fails when the test Worker enables a compatibility feature that production lacks, usually after a `@cloudflare/vitest-plugin` upgrade. Add the flag to the production flags in `infra/worker-settings.ts`.
- A busy machine can push a test past Vitest's 5 s timeout. Rerun that test alone before you suspect your change.

`verify` cannot see runtime faults, such as an idle container that keeps running:

- After a staging deploy or an e2e run, run `pnpm ops:check` (`docs/agents/design/observability.md`, "Checking a running deployment").
- Before you merge a risky change to the Worker, the Supervisor, the Workspace Host or the facet, run `pnpm e2e` (`docs/deploy.md`, "End-to-end run"). It deploys a throwaway stage and costs container time and model calls.
- `pnpm ci:local` runs the whole CI chain from this machine (`docs/deploy.md`, "Preview stage and `pnpm ci:local`").

## Cloudflare and Alchemy

For deploys (a push to `main` deploys through GitHub Actions; `pnpm run deploy [<stage>]` deploys by hand), `pnpm ops:check`, staging a risky change, or diagnosing container cost and idle stops, use the `cf-operations` skill (`.agents/skills/cf-operations/SKILL.md`). `docs/deploy.md` is the human runbook.

- `infra/alchemy.run.ts` is the only description of the Worker; there is no Wrangler config. Shared values live in `infra/worker-settings.ts`, which the Worker bundle includes, so keep it free of `node:` imports.
- Vitest runs the Worker from the Miniflare options in `infra/test-worker.ts` (no `AI` binding, no container).
- Every stage other than `prod` is a separate Worker, `cf-stumble-<stage>`. There is no local dev server (`alchemy dev` needs the production state store), so test on a staging stage.
- Run Alchemy from the repo root as `pnpm alchemy <command> --config infra/alchemy.run.ts`. `infra/` is its own pnpm project; `pnpm install:infra` installs it.
- Alchemy's state lives in the account's `alchemy-state-store` Worker. Never delete it. After anything changes the Worker outside Alchemy, deploy with `--force`.
- Use `pnpm exec cf` for secrets, container applications, images, deployment lists and auth.
- Per-instance values (`OWNER_PASSWORD`, `HARNESS_REPOSITORY_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GH_TOKEN`, `ORB_PROVIDER_TOKEN`) are Worker secrets the stack never declares, so a deploy keeps them (`docs/deploy.md`, "Instance secrets").

## Browser checks

`verify` never opens a browser. To check the owner page, open a staging copy with the `chrome-devtools` MCP server and read its snapshot, console and network requests. The page needs Basic auth: set an `Authorization: Basic <base64 of aditya:password>` header with the `emulate` tool (`extraHttpHeaders`) and open the plain URL. Credentials in the URL break the page's own `fetch` calls.

## Editor setup

Point the editor at `pnpm exec tsrs --lsp -stdio`, or it will disagree with `verify`. In VS Code, install `TypeScriptTeam.native-preview` and set `"js/ts.experimental.useTsgo": true` and `"js/ts.tsdk.path": "./node_modules/tsrs/tsdk"`. To see the `lint:effect` diagnostics too, run `pnpm exec effect-tsgo tsrs --lsp -stdio` instead of plain `tsrs`, not beside it. The language server misses some editor features; trust `pnpm typecheck`.
