# Worker Previews adoption probe

Playbook: **figure-it-out** (large/cross-cutting, and the owner reviews it after sleeping).
Task slug: `worker-previews-adoption`. Decision trail: `.audit/worker-previews-adoption.tsv`.
Evidence: `.audit/evidence/previews/`.

## Start

- [x] Read the Principles section of poteto-mode in full.
- [x] Write these phases to `.audit/worker-previews-adoption.md` before task-specific planning.

## Phase A: Frame

- [x] State done as a falsifiable predicate (prove-it-works).
- [x] Quantify scope and surface blockers before spending hours.
- [x] Set the rigor level, biased high.
- [x] Present the framing before committing to the long run. Owner is asleep, so proceed on reversible work (never-block-on-the-human) and flag the one-way doors in the reply.

## Phase B: Design the workflow

- [x] Decompose into atomic, independently-landable units, riskiest unknown first.
- [x] Build the verification harness before the work, baseline captured from the pre-change state.
- [x] Route one-way-door design decisions to a judge on another model family (sol-high stands in for architect/arena here; the decision is doc-shaped, not code-shaped).
- [x] Decide what fans out, one worker per genuine seam.
- [x] Write the designed steps into this file after Phase C and before Phase D.

## Phase C: Run the loop

Each unit states a hypothesis, makes the smallest change, measures against the predicate on the real artifact, and keeps or reverts.

- Verify by inspecting the artifact, never a self-report.
- Pair delegated work with a judge and audit the delegates' artifacts.
- A verdict is VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a pass.

### Designed steps

- [x] C1. Facts. Mine every Worker Previews docs page plus the `wrangler preview` CLI reference into `.audit/evidence/previews/facts.md`, with exact quotes and source URLs. Delegate: claude-sonnet-5.
- [x] C2. Repo fit. Map cf-stumble's `wrangler.jsonc` and `src/` to a concrete `previews` block, and list blockers. Delegate: claude-sonnet-5.
- [x] C3. Architecture judgment. Ask sol-high whether Previews change the version 0 cut line, and specifically whether candidate generations should be Previews instead of Worker Loader module maps. One consult, budgeted.
- [x] C4. Baseline. Record pre-change account state: `wrangler preview settings`, `wrangler deployments list`, `wrangler containers list`. Evidence under `.audit/evidence/previews/baseline/`.
- [x] C5. Probe 1, deploy. `wrangler preview --name probe0 --json` from a scratch branch with a `previews` block that omits R2. Predicate: the command returns a Preview URL and `GET /` on that URL returns the same body the local `GET /` startup check expects.
- [x] C6. Probe 2, Durable Object isolation. Write state through the Preview URL, then confirm production has no such state. Predicate: the Preview's Supervisor namespace is separate.
- [x] C7. Probe 3, Worker Loader. Load a module map inside the Preview through the `LOADER` binding and run its `GET /`. This is feature-map P0's blocking unknown, so a pass here is the highest-value result of the night.
- [~] C8. Probe 4, Access. INCONCLUSIVE: the docs confirm workers.dev Preview URLs can sit behind Cloudflare Access with no custom domain, but this OAuth token has no Access scope, so nothing was proven. Owner action needed. Determine whether a `workers.dev` Preview URL can be put behind Cloudflare Access without a custom domain. Document only, change nothing.
- [x] C9. Cleanup. `wrangler preview delete`, then `wrangler containers list` to catch the documented leftover-app case. Leave the account as C4 found it, minus anything the owner should keep.
- [x] C10. Write-up. `docs/agents/design/worker-previews.md` with the recommendation, and a feature-map or ADR change only if a probe earned it.
- [x] C11. Second opinion on the write-up, different model family from the writer.

## Phase D: Keep the audit trail

- [x] One TSV row per decision and per unit, evidence as paths, written as each step lands.
- [~] Commit the trail with the write-up so the owner can read it without the transcript. `skip: .audit/ is gitignored in this repo, and the owner asked for the questions file to stay untracked. The committed doc cites every evidence path instead.`

## Phase E: Verify and hand back

- [x] Check the whole against the Phase A predicate on the real product.
- [x] Encode any recurring correction as a gate or script.
- [x] Reply: the playbook, the rigor level and why, the trail path, what is verified, what is open.

## Phase A framing, recorded

**Predicate.** The night is a pass when all four hold:

1. `.audit/evidence/previews/facts.md` answers, with quotes, whether a Preview supports Durable Objects, `worker_loaders`, containers, R2, secrets, and Cloudflare Access.
2. A Preview of the real cf-stumble Worker deployed on this account and served `GET /`, with the raw command output kept, or the exact failure is recorded with its cause.
3. The Worker Loader question from feature-map P0 has a verdict from the paid runtime: VERIFIED, NOT VERIFIED, or INCONCLUSIVE with the reason.
4. `docs/agents/design/worker-previews.md` states what to adopt, what to reject, and what it changes in the version 0 plan, and the account is back to its baseline state.

**Scope.** One repo, one Worker, no custom domains, no production deploy. Roughly ten units, most of them minutes long. Two paid-account actions: a Preview deploy and its deletion.

**Blockers known at framing time.**

- R2 is not enabled on the account, and only the owner can enable it from the dashboard. Recorded in session memory. Previews do not inherit production bindings, so a Preview can omit R2 and still deploy. That is the workaround this probe uses.
- Workers Paid and container access are unverified.
- `wrangler preview` is private beta in Wrangler 4.126.0, so an unsupported binding may fail in ways the docs do not describe.

**Rigor: high.** The output changes the version 0 cut line, which every remaining job depends on. Probes run against the real account, and each one keeps raw output rather than a summary.

**One-way doors, flagged for the owner.**

- Nothing in this run merges to `main` except documentation.
- Deleting a Preview deletes its Durable Object state. That is fine for a probe named `probe0` and is why the probe does not reuse a real tenant name.

## C12. Container probe, run and passed

Run after the owner corrected the plan fact. My claim that the Workers plan was unconfirmed came from piping the JSON subscription list through `head -30`, which dropped the `workers_paid` entry. Result: VERIFIED. A container served `container ok` inside a Preview once `instance_type` was `basic`. Evidence in `.audit/evidence/previews/container/`.

Procedure, when approved:

1. Add a container class to a probe branch with a trivial Dockerfile, plus `previews.containers` and a `new_sqlite_classes` migration for it.
2. `pnpm exec wrangler preview --name probe-container`.
3. Request a route that calls the container, and keep the raw response.
4. `pnpm exec wrangler preview delete --name probe-container --skip-confirmation`.
5. `pnpm exec wrangler containers list`, then delete any app whose name starts with `cf-stumble_probe-container_`.

Open question it answers: whether this account has Workers Paid and container access at all. `cf user subscriptions get` shows only a zone-scoped free plan, so the feature map's claim that a paid account is available for Computer is unverified.

## Phase E result

Predicate checked against the real artifacts, commit `7e53445`.

1. Fact base, PASS. `.audit/evidence/previews/facts.md`, 254 lines, one quote and URL per claim.
2. Real Preview deployed and served, PASS. `GET /` returned 200 `main facet ready` on `https://probe0-cf-stumble.adityakompella.workers.dev`, raw output in `probe/curl-root.txt`.
3. Worker Loader verdict for feature-map P0, VERIFIED with a narrower scope than P0 asks. The production runtime accepted a module map through `worker_loaders` and ran the loaded facet's Durable Object class. The map came from the repository fixture, not from a Computer build, so P0's own check stays open.
4. Write-up and baseline, PASS with one delta. `docs/agents/design/worker-previews.md` is committed. Both Previews are deleted and 404. The account keeps an empty `cf-stumble` Worker record with no production deployment, raised as Q3 in `.audit/morning-questions.md`.

Correction encoded: the review found the isolation numbers unreproducible, because the throwaway `/probe/state` route was reverted and one deploy output was never captured. Both are now saved under `.audit/evidence/previews/probe/`, and the reproduction procedure in the committed doc points at the saved route. Q11 asks whether that route should become a real, tested endpoint so the next probe needs no throwaway patch.

## C12 findings

1. Containers run in a Preview. `GET /probe/container` returned `container ok` on the first attempt with `instance_type: "basic"`.
2. `instance_type: "dev"`, now renamed `lite`, never schedules on this account. The instance stays `inactive` and the Durable Object only sees "There is no container instance that can be provided to this Durable Object, try again later". Production failed the same way, so it is not a Previews fault.
3. `wrangler deploy` fails on this account because R2 is disabled, while `wrangler preview` succeeds. Previews are deployable where production is not.
4. Cleanup takes three commands, not one. Preview deletion left the container app running, and the registry images outlived the app.
5. Two of my own errors cost time. The first Dockerfile used `httpd` from a stock alpine image, which does not include the applet, and the first probe swallowed the fetch error instead of returning it. Surfacing the error text and reproducing the image locally found both.
