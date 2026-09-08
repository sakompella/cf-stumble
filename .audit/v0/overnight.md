# cf-stumble v0 — overnight checklist

Written before the first iteration. Every item ends `done`, `blocked: <reason>`, or
`skip: <reason>`. Mirror of the host persistent goal. Durable home `.audit/v0/` (gitignored).

Objective: finish cf-stumble v0 per `/tmp/cf-stumble-v0-handoff-2026-09-08.md`.
Done predicate: every item below done or skipped with a reason, `pnpm verify` green at the head of
`main`, `main` pushed to `origin`.

## Playbook steps (poteto-mode, Autonomous run, verbatim)

1. Write `.audit/<task>.md` before the first iteration. It names the durable objective, checkable
   done predicate, evidence, and each completed or skipped step. A host persistent goal is
   preferred when available and must use the same objective and predicate. The checklist remains
   the portable source of truth.
2. Arm one named portable loop when a command can check the predicate. Use `scripts/loop/loop
   --repo . arm <task> --objective "..." --predicate "..." --interval <seconds>`. The interval
   records when a human should consider the next check. It does not schedule a run or wake an
   agent. Run `scripts/loop/loop --repo . tick <task>` manually, inspect `status <task>`, and use
   `cancel <task>` to stop recovery work.
3. Each iteration makes the smallest change the evidence justifies, verifies it against the
   predicate, records the result in the checklist, and commits if it advanced. Discard changes that
   did not help. Sequence the work via the sequence-verifiable-units principle skill, verifying
   each unit before the next instead of batching checks at the end.
4. Mid-run discoveries are yours. Address broken skills, related bugs, flaky verifiers, review
   noise, tooling failures, orphaned follow-ups, and fixable drift yourself via poteto-mode. Put
   out-of-band fixes in their own PR. Surface only irreversible actions, genuine product or
   preference calls no experiment can settle, or a real dead end. Return to the predicate after
   each side fix.
5. Stop when the predicate is met. A plateau is not a stop, so pivot the approach. Preserve the
   checklist and loop state for a later manual resume. If a mutation lock is busy, recover only
   with `scripts/loop/loop --repo . unlock` after it confirms a dead local PID.

Step 2 note: `scripts/loop/` does not exist in this repo, so the portable loop is not armed. This
file plus the host persistent goal are the source of truth. `skip: no loop tooling in this repo,
and building it is off the critical path (handoff decision 14)`.

## Legend

`[x]` done. `[~]` in progress with evidence. `[ ]` not started. `blocked:` and `skip:` carry a
stated reason.

## Items

### Setup

- [x] S1 `git fetch --all`, reconcile local `main` with `origin/main`. done: local was behind 1,
      fast-forwarded to `e769586`.
- [x] S2 Read the handoff, `AGENTS.md`, `docs/agents/domain.md`, poteto-mode in full, `.audit/v0/`
      state. done.
- [x] S3 Probe Cloudflare credentials on hp before planning deployment. done: the owner copied
      wrangler OAuth credentials to `~/.config/.wrangler/config/default.toml` during the run.
      `pnpm exec wrangler whoami` authenticates as `kompella.sa@northeastern.edu`, account
      `0817758e93f2d197d0c512d94f276650`, with `containers`, `workers`, `d1`, `ai` and
      `secrets_store` write scopes. B is not blocked.

### A. Plan-doc rewrite (handoff decision 12)

- [x] A1 Rewrite `docs/agents/design/feature-map.md` as a plain ordered checklist. done: `25ceaff`,
      merged as `c9ab4d7`. No phases, no task ids.
- [x] A2 Rewrite `.audit/v0/goal.md`. done: rewritten as a plain checklist with the cut criteria
      removed.
- [x] A3 Supersession notices. done: ADR-0028 and ADR-0034 carry them; ADR-0031, ADR-0032 and
      ADR-0034 were deleted outright with their index entries when their code went, which is what
      `docs/agents/domain.md` requires. The glossary lost the terms whose code is gone.
- [x] A4 State the harness self-edit path. done: `feature-map.md` states the real Git clone, the
      `git archive` build and the working-directory selection.
- [x] A5 `writing-for-agents`, then `humanizer`, then `unslop`. done: terra ran all three over the
      plan documents and over `tools/browser-harness/README.md`.
### B. Baseline smoke deploy

- [x] B1 Deploy current `main` to the paid account, record page-behind-Access plus status route.
      done. `https://cf-stumble.adityakompella.workers.dev` serves. Unauthenticated requests get
      401; a request with a credential and no Access configuration gets 500, so the Worker fails
      closed. Evidence and the four container-image findings are in
      `.audit/v0/evidence/deploy-baseline-smoke.md`. The tracked config could never have started a
      container, which this smoke found and commit `b0eef15` plus the image work fixed.
- [x] B2 Repeat the same smoke after the simplification commits. done, on the post-simplification
      deployment: `GET /` with no credential 401, with an unverifiable credential 401, with a
      verified credential and an HTML accept 200 and 42 KB of owner page, without one 503
      `no-active-generation`; `/api/status` 200 at epoch 3; `/api/projects` 200 with the harness
      entry in 1.5 s. Table in `.audit/v0/evidence/deployed-plumbing-probe.md`.

### C. Simplification commits (serial, gate after each, sol review before merge)

- [x] C1 Tenant guard deletion (decision 8). done: `99afdd3`, merged as `7ab3a9c`. sol reviewed and
      its one blocker (a comment still promising the deleted refusal) was fixed before the merge.
- [x] C2 `ctx.id.name` fallback (decision 9). done: `dc2f192`, merged as `7ab3a9c`, in its own
      commit. sol audited every raw-id call path and found none in production.
- [x] C3 R2 rip (decision 6). done: `4b55948`, merged as `6ceb830`. `keep/r2-module-cache` is
      pushed. Module maps are 1 MiB UTF-8 chunks plus a manifest row, written in one
      `transactionSync`; the atomicity test was mutation-checked. `prepare` may build, `load` never
      does, so rollback cannot rebuild.
- [x] C4 Recovery, eligibility and turn-credit deletion (decision 7). done: `f236db0`, merged as
      `0ee5b99`. 61 files, -5874 lines. The turn lease stays.

### D. Deployed plumbing proof

- [x] D1 Facet to Computer workspace, deployed. done. The deployed container answers a workspace
      command in about two seconds after four fixes, each proved by a deployed failure and recorded
      in `.audit/v0/decision-log.md` D75: Cloudflare cannot pull the pinned ghcr image; that image
      is a scratch layer holding only `computerd` and exits 1; `FUSE_MOUNT=auto` exits 1 in a
      Cloudflare container while `shim` serves; the image needed `gh`, `tar` and corepack. The
      workspace name is derived from the verified identity
      (`tenant:access:18a751...`), so the container is the tenant's own.
- [x] D2 `pnpm run build:artifact` module map from a commit, deployed. done. A submission builds
      the named commit in the tenant's container and stores a 942311 byte module map: 334 s to
      439 s on a cold pnpm store. Five deployed-only bugs had to be fixed first; all five are on
      `main` and listed in `.audit/v0/evidence/deployed-generation-loop.md`.
- [x] D3 Worker Loader load under the commit id. done: the candidate facet cold-starts under the
      commit id and answers `GET /` with 200, and after activation `GET /` on the deployment serves
      that generation's own facet.
- [x] D4 Model route streaming. done: a deployed turn streams `tool-start`, `tool-result`, `text`
      and `diff` frames from Workers AI through the route. Three bugs in that path were found and
      fixed, the last of which threw away every answer: the parser read only Workers AI's classic
      `{response}` shape while the model streams chat-completion chunks.
- [x] D5 Raw timings and failures as probe notes. done: `.audit/v0/evidence/deployed-plumbing-probe.md`.

### E. The real coding turn

- [x] E1 The real coding turn, deployed. done. With the product's own tools: `read` README.md,
      `write` 139 bytes back to it, `bash` for `git diff --stat -- README.md` which printed
      `1 file changed, 3 insertions(+)`, streamed text explaining the work, the harness's own diff
      frame, and a saved thread. 9.8 s. The first attempt exposed a real defect, since fixed
      (`a50b14a`): every write answered `backend-unavailable` because it ran inside Computer's SQL
      transaction rather than the Durable Object's.
- [x] F1 Submit, build, cold check, activate, continue. done deployed: two generations built and
      activated, a stale epoch refused with `stale-epoch`, activation in 0.3 s, and the same
      conversation continued in the same workspace afterwards.
- [x] F2 Rollback loads the stored module map with no build step. done deployed: rollback to
      generation 3 took **0.26 s**, and `wrangler tail` for that window shows two Supervisor calls
      and no Workspace Host call at all, so nothing was built. The thread and the project edit
      survived.
- [x] F3 Deployed log evidence for the narration. done: both clips exist.
      `probe/broken-candidate` (`cf8190e`) built, cold-started and answered `GET /` with 500, so
      the Supervisor recorded `stage: response-rejected`, marked the candidate `failed`, and the
      active generation kept serving. Rollback then loaded the stored map in 0.26 s with no build.
      Both are quoted with their raw responses in
      `.audit/v0/evidence/deployed-generation-loop.md`.
- [x] G1 The page, deployed and in a real browser. done: `15b3b40`, merged as `6a0c776`, and then
      driven against the deployment with headless Chromium and the Access token as the
      `CF_Authorization` cookie. The sidebar lists `harness /workspace/harness`, clicking it sets
      the conversation to that project, the drawer reads the real active generation (label 3,
      commit `a199797`, ready, epoch 13), four page-driven turns completed and saved, and the
      transcript carries the earlier coding turn with its tool calls and diff after a reload. Zero
      console errors. Section 8 of `.audit/v0/evidence/deployed-generation-loop.md`.
- [x] G2 Merged web test case list. done: `.audit/v0/web-test-cases.md`, 40 cases over six
      surfaces, 12 must and 28 should, merged from independent opus-5 and sol sets with one
      disagreement kept explicit.
- [x] G3 Parallel luna end-to-end runs, one per surface. done. The advertised harness was a
      four-assertion smoke check, not the six-surface suite `AGENTS.md` claimed, so a worker built
      the runner, the case contract and the chat surface, then five luna agents ran the generation
      drawer, sidebar, keyboard, narrow and wide surfaces in parallel. They found four real page
      defects, one of them independently on four surfaces, and two cases that were wrong about the
      product. All of it is fixed and merged as `2f93de4`. `pnpm harness:browser` at the head of
      `main`: **41 cases, 41 passed, 0 failed**.
- [x] H1 Bounded deletion. done: two tests deleted, each with the mutation that proved it
      decorative. The five tests `review-sol-tests.md` calls decorative were **kept**: suppressing
      the post-turn diff turns all five red, so they bind real behavior. Merged as `8ef91b9`.
- [x] H2 done: two Hegel properties on the turn lease, each mutation-checked against the existing
      771 tests. The epoch property was not added because
      `generations/decisions.props.test.ts` already states the epoch arithmetic.
- [x] H3 done: `work/test-pass`, finished and green, merged as `8ef91b9`.

### I. Deploy button and user-facing deploy docs

- [x] I1 done: the official button at the top of `README.md`, pointed at
      `https://github.com/sakompella/cf-stumble`, with one sentence and a link to the guide.
      Merged as `efa0cd4`. Checked as far as an agent can: the repository answers 200 and is
      public, the button image serves, and the button URL redirects to Cloudflare's
      `workers-and-pages/create/deploy-to-workers` flow carrying this repository as its
      `repository` parameter. Finishing the flow needs a logged-in browser, which is I6.
- [x] I2 done: `docs/deploy.md`. Prerequisites, what the button does and does not do, the
      container image and why docker rather than podman, Access step by step with where each value
      comes from, connecting a project, first run, the fork gap, the untested areas and the cost.
      Every claim this run could not support is written as a limit rather than a claim.
- [x] I3 Verify the built Worker fails closed with `CF_ACCESS_*` unset or partial. done for both
      against the deployment. Unset: 401 with no credential, 500 with one. Partial (team domain
      set, audience and owner subject absent): 401 with no credential and 500 on `/`,
      `/api/status`, `/api/projects` and the browser page path with one. 500 is
      `invalid-configuration`, which says the fault is the deployment's own.
- [x] I4 Already done before this run, and enforced: nothing under `src/` imports
      `src/facet/fixture.ts`, and `test/facet/fixture-reach.test.ts` fails if anything starts to.
      Verified by reading both.
- [x] I5 Bootstrap from genuinely empty storage. done: a fresh verified identity produced a fresh
      Supervisor at `epoch 0` with no generations and its own container named from that identity.
      The first authenticated request provisioned the workspace and cloned the harness repository,
      and the first submission labeled generation 0 through the ordinary path with no special-case
      machinery. Everything above happened on that instance.
- [~] I6 Prove the button flow end to end against a clean account. `blocked: Cloudflare's fork and
      provisioning screen needs an interactive browser login and a second account, so no agent can
      finish it.` Everything either side of that screen is now proved. Before it: the repository is
      public, the button image serves, and the button URL reaches Cloudflare's
      `workers-and-pages/create/deploy-to-workers` flow carrying this repository. What the screen
      consumes: the tracked `wrangler.jsonc` provisioned a brand-new Worker with both Durable
      Object namespaces and their migrations, the container application, and every binding, and
      that Worker failed closed with no configuration exactly as the guide says (section 7 of
      `.audit/v0/evidence/deployed-generation-loop.md`). The probe Worker was deleted afterwards.
      After it: a fresh instance with empty storage runs the whole demo path.
- [x] J1 `work/T17` dropped, per decision 13. It is a `wip(...)` commit from a worker that was
      killed, based on a `main` from before ten merges, and it changes `vitest.config.ts` to add a
      Node test pool. Not green as it stands, so decision 13 says drop. The gap it aimed at is
      recorded instead: the turn-diff test imports `TURN_DIFF_COMMAND`, so no test fails if the
      command stops being Git.
- [x] J2 Decision log current in `.audit/v0/decision-log.md` (D75 to D81); `.audit/v0/STATE.md`
      rewritten for this run.
- [x] J3 `pnpm verify` green at the head of `main`, and `main` pushed. 108 test files, 776 tests.
- [x] J4 Out of scope, stated: the demo recording is human made. `skip: owner directive 3`. The log
      evidence the human would narrate is partly captured; see F3.

## Where this run ends

Done, and proved against the real paid account: the whole seven-step demo path except the parts
that need a browser and a human. A commit becomes a generation, activates, serves, and rolls back
in a quarter of a second without a build; a deliberately broken candidate fails its startup check
while the active generation keeps serving; and a real coding turn reads a file, edits it, runs a
command, streams its work and saves its thread. `.audit/v0/evidence/deployed-generation-loop.md`
quotes every response.

Done locally and merged: the plan documents, the four simplification commits, the page with the
harness as a selectable project, six web surfaces with all 41 cases passing, the bounded test pass,
the deploy button and the user-facing deploy guide.

Eight bugs came out of the deployed run, every one of them invisible to `pnpm verify`. All eight
are fixed on `main`.

Two things are still open, and both need a human rather than an agent:

- The Cloudflare Access application. `POST /access/apps` is refused by this token, so the owner
  creates the application, adds the owner policy, and reads the `sub` claim from the first login.
  `docs/deploy.md` has the steps. Deployed probes used an injected JWKS instead, and no claim is
  made about Access admitting the owner.
- The deploy button against a clean account. It needs a browser login and a second account.

The `HARNESS_REPOSITORY_URL` variable a fork has to change is also proved deployed: with a
repository that does not exist, a submission fails at its provision step in 16.5 s and the active
generation does not move.
