# Autonomous v0 run

## Objective

Advance cf-stumble to a deploy-ready, owner-only version 0. Use the fixed Workers AI route first. Treat Codex or ChatGPT login as a separate compatibility experiment. Do not make version 0 depend on it unless a real supported HTTPS callback works.

## Done predicate

`pnpm verify` passes, the paid evidence proves R2, the fixed Workers AI request, and the pinned Computer path, and the owner-only deployment is ready for a final explicit deployment confirmation. A later final deployment and recorded demo require a separate irreversible-action confirmation.

## Data shapes

- `RuntimeProbeEvidence` records the R2 object key and outcome, the fixed model and redacted response metadata, and Computer command outcome. It contains no tokens, prompts, or repository contents.
- `CodexLoginExperiment` is a discriminated result. It is either `supported` with a documented HTTPS callback/client registration, or `unsupported` with the observed redirect rejection or absent registration evidence.

## Throughput checkpoint

After every unit, record the changed files, direct evidence, verification command, next dependency, and whether the worktree is clean. Do not begin the next unit until its direct check passes.

## Scope expanded by the owner on 2026-09-03

Work all the way through version 0, then verify the finished system end to end with several Sonnet 5 subagents driving a real browser. Paid probes, production deployment, and the recorded demo still need explicit owner approval.

Verification prerequisites found so far: `browser-use` is installed, `anthropic/claude-sonnet-5` is available for subagents, and this machine has Firefox but no Chrome or Chromium, so a local headless Chromium is needed for CDP. Browser navigation cannot set the `cf-access-jwt-assertion` header, so the page path must also accept the `CF_Authorization` cookie that Cloudflare Access sets.

## Product decisions recorded after the original plan

The owner requires streamed Pi turns, a collapsible GitHub-project sidebar, one current Pi thread
and one isolated Computer workspace per project, and a fresh-thread action that preserves project
files. Project workspaces are normal trusted development machines with unrestricted internet,
`git`, `gh`, and GitHub credentials in local configuration. ADRs 0037 through 0039 and the updated
feature map record these decisions. They supersede the buffered turn, manually selected session,
single fixed workspace, and no-egress assumptions below.

## Open questions the build wiring exposed

1. The build workspace reads `/harness/.git`, and nothing populates it yet. Seeding that Git directory is unbuilt.
2. The Workspace Host still sets `egress: { mode: "none" }`. The owner resolved this design question:
   project workspaces must have unrestricted internet access. The code has not implemented the
   decision yet.
3. `PROJECT_WORKSPACE_NAME` is a module constant today. The code must derive one Workspace Host
   identity per tenant-owned project. The harness build workspace remains separate from project
   workspaces.
4. Both surfaces share one `WorkspaceHost` class, isolated only by Durable Object name. Whether a build instance needs its own container configuration is untested.

## Checklist

- [x] Establish baseline. Commits `64826cf` and `36c12bf` are clean. `pnpm verify` passed with 36 files and 194 tests.
- [x] Configure owner-only Access. `stumble.akompella.dev` has one public-hostname destination and an exact-email Allow policy. Local setup values remain ignored.
- [x] Approve paid probe. Local approval is `yes`.
- [x] Create the rerunnable minimal paid-probe lever. `scripts/probe/run.sh` deploys a uniquely named disposable Worker behind a single-run bearer secret, records a run manifest, proves the R2 round trip and one fixed-model request, and always cleans up its own resources. Commit `9c21054`. Never executed yet.
- [x] Add the deploy-time Access configuration guard. `scripts/deploy/check-config.sh` fails closed and prints presence and length only. Commit `cf30493`.
- [x] Replace the prompt-only model request with a validated message contract that carries tool calls and tool results, while the immutable host keeps the model, reasoning effort, and credentials. Commit `7970c71`. 38 files and 229 tests pass.
- [x] Run the paid probe. R2 write, R2 read back, and one fixed Workers AI request all passed, and the probe deleted its Worker and R2 object. Evidence is `.audit/paid-runtime-evidence.md`.
- [x] Add Access verification and identity-derived Supervisor name. Signature, issuer, audience, expiry, and stable identity are checked. Keys load from the Access JWKS with a cache and rotation refresh. Commit `0f417cf`. `pnpm verify` passed with 38 files and 209 tests.
- [x] Vendor the pinned Computer package from a clean clone outside this repository. A second independent build produced the identical checksum `9700592b...42f9`, and `scripts/vendor/verify-computer-tarball.sh` re-derives it. Commit `959b7d3`.
- [x] Add the Computer workspace host. Root-confined read, write and list, one configured command with its exit code, and a fixed git diff, returning plain cloneable values with container egress disabled. Offline fake-backend tests cover normal and rejected paths. Commits `c76f603`, `7ab77f0` and `e32b498`. Container `instance_type` is `basic`, because `lite` never schedules on this account. Giving the facet this capability is still open.
- [x] Add the Supervisor session turn transaction. One turn takes the lease, loads the saved document, calls the facet, validates the returned document, text, and command records, commits with the revision advance, and releases the lease. Failure releases the lease without advancing the revision. Commit `8b2bc91`.
- [x] Harden the Access gate after an independent attack review. Credentials are stripped before generation code, JWKS refreshes are coalesced with a cooldown, and an http team domain is rejected. Commit `1e07725`.
- [ ] Connect Pi, Computer, and the fixed model route so one buffered coding turn runs real work.
- [x] Fix the gate flake. Tests now load a copy of the Worker configuration without the AI binding, so no Workers test opens a remote connection. A drift check keeps the copy identical apart from the name and that binding. Commit `e9cc53a`. Three consecutive runs were clean with zero remote connections.
- [ ] Build a candidate module map from a harness commit and prove R2 cache load plus cold startup.
- [~] Add the owner-only HTTP routes and one page. Status, session read, and session turn now run behind Access verification with a server-derived Supervisor name, JSON 400 for a malformed body, and JSON 404 for unknown routes. Commit `4f76bd4`. Activate, rollback, and `GET /api/recovery/latest` now run with epoch checks and journaled request IDs against a real Supervisor. Commit `0982751`. Generation submit and the page remain open; submit waits for the module-map resolver.
- [x] Settle the Codex login decision from evidence. Primary-source research in `.audit/research/codex-oauth-web-prior-art.md` shows ChatGPT sign-in is a Codex client method with a localhost callback, and OpenAI documents no public redirect-URI registration for a third-party web client. Version 0 therefore keeps the fixed Workers AI route and does not depend on Codex web login. Revisit only if OpenAI publishes a supported HTTPS callback registration.
- [ ] Produce deployment and two-minute demo evidence. Pause before the final production deployment.

## Skipped

- Worker Previews. The owner rejected them and the configuration was removed.
- Codex web login implementation. Pending the compatibility experiment. Existing localhost CLI prior art is not enough.

## Documentation checkpoint: owner-approved product model

Changed tracked files: `docs/agents/CONTEXT.md`, ADR index, ADRs 0037 through 0039,
`docs/agents/design/overview.md`, `docs/agents/design/feature-map.md`, and
`docs/agents/design/computer-integration.md`. Updated the ignored live plan and design-question list
as well.

Direct evidence: the current feature map now requires streamed Pi turns, GitHub projects in a
collapsible left sidebar, one current Pi thread and isolated Computer workspace per project, fresh
thread without filesystem reset, unrestricted workspace internet, normal `git`/`gh`, local GitHub
credentials, and the managed runtime `AGENTS.md` instruction. A Sonnet documentation review found
one accidental generation-control placement decision; it was removed and Q6 remains open.

Verification: `pnpm verify` passed with 63 test files and 428 tests. Next dependency: revise the
implementation sequence around project identity, Pi streaming, and per-project Workspace Hosts
before changing source code. The tracked worktree will be clean after the documentation commit.
