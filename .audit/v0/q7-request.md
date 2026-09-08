# Q7, re-specified: the paid request, mapped to criteria

Written 23:35 on hp, by the oracle, for the owner. This document **supersedes the five Q7 addenda**
in `.audit/v0/questions.md`. Those accreted one at a time across the overnight run and now repeat
each other; read this instead. The addenda stay in place as history.

Astra's instruction (`.audit/v0/review-astra-low.md` section 1) was to prepare this now rather than
after the six code fixes, so it is waiting when you land. D74 records why.

## What changed since you were last asked

Two things, and both shrink the request.

1. **The work moved to hp, an x86-64 NixOS box with Podman.** The pinned
   `ghcr.io/cloudflare/computer-computerd-linux-x64` image runs here. An arm64 Mac could not start
   it. Pulling and running a public image is free.
2. So **most of what the old addenda asked you to authorize can now be answered locally, for
   nothing.** Task T20 is running that preflight right now. Every row below marked `T20` is a
   question I expect to answer myself within the hour.

The residue — the rows marked `PAID` — is what actually needs your money and your accounts. That
residue is the real request, and it is much smaller than the last version.

## The one decision that gates everything

**May an unsupervised agent spend paid Cloudflare budget, and in which environment?**

"An approved disposable paid environment" is not a name. I need a name. Concretely:

| # | what I need | why it cannot be defaulted |
|---|---|---|
| 1 | A named non-production Cloudflare account, **or** a resource-name prefix for this run's Workers, R2 bucket, Durable Object namespaces and Container | Without it a probe can overwrite a resource you care about. This is the only irreversible-damage risk in the paid set. |
| 2 | A spend ceiling, per task or for the run | Every paid task should stop on the first paid failure and record it. |
| 3 | A throwaway GitHub owner and disposable repositories probes may clone and push to | Default assumed: **no** probe pushes to a repository you care about. Confirm. |
| 4 | The exact R2 bucket T8's lifecycle rule may act on | That rule **deletes objects**. |
| 5 | A publication destination, or an explicit "not yet" | This is Q5. It gates criterion **10b** only. Criterion 10a no longer waits on it — see the goal.md split. |

## The evidence list, mapped to the criterion each item unblocks

Each row names one criterion, one measurement, and who can answer it.

| # | measurement | criterion | who |
|---|---|---|---|
| 1 | `gh --version` present in the pinned image | 3 | **T20**, free |
| 2 | `tar` present (the checkout step runs `git archive` + `tar`) | 7 | **T20**, free |
| 3 | `node` version in the image (recorded as 22.23.2 — confirm) | 7, 8 | **T20**, free |
| 4 | pnpm bootstrap: `package.json` pins `pnpm@11.18.0`, the container ships 11.24.0, so it downloads pnpm before install starts. Never once observed. | 7 | **T20**, free |
| 5 | Registry throughput for 186 packages, ~145 MB compressed / ~496 MB unpacked | 7 | **T20**, free |
| 6 | Cold-build wall time. 13 s locally with an empty store; T1a recommends a 900 s container timeout until measured. T9 and T12 inherit the number. | 7 | **T20**, free |
| 7 | Disk: 491 MB build directory + 598 MB cold store measured locally | 7 | **T20**, free |
| 8 | Outbound HTTPS to `github.com` (`git clone --no-checkout`, `git fetch`) | 3 | **T20**, free |
| 9 | **Two clean COMPUTER builds of one labeled commit produce identical module maps** | 7 | **T20** proves it locally in the real image; a deployed repeat is `PAID` |
| 10 | Does `env.AI.run("@cf/zai-org/glm-5.3-flash", {stream:true, tools:[...]})` deliver text deltas and tool-call fragments incrementally? | 4 | **PAID**, ~5 minutes |
| 11 | Cloudflare Access admits only the owner; two authenticated browsers reach the same Supervisor; unauthenticated and cross-tenant requests fail | 2 | **PAID**, needs a deployment |
| 12 | GitHub connection through authorization separate from Access; credentials leak into no tracked file, log, response, R2 map or facet state | 3 | **PAID** |
| 13 | Worker Loader loads a commit-named module map; cold-start; a missing or corrupt R2 map rebuilds under the same commit identity | 7, 8 | **PAID** |
| 14 | R2 cache age rule configured and observed | 7 | **PAID**, and it deletes — see decision row 4 |
| 15 | Restart / eviction preserves active selection, connected-project records, threads and project files | 9 | **PAID** |
| 16 | Shared-container concurrency behaviour | 9 | **PAID** |
| 17 | Actual disconnect and deadline behaviour under a real deployment | 6 | **PAID** |
| 18 | The two-minute recording of the seven-step workflow | 10a | **PAID** (needs 11-17 deployed) |
| 19 | Publishing that recording | 10b | **OWNER**, Q5 |

## The three cheapest paid probes, if you want to approve a subset

Ordered by how much they de-risk per dollar. Each can invalidate a whole task, so each is worth
running before the rest.

1. **Row 10, the streaming model probe.** About five minutes. If deltas do not arrive incrementally,
   Q6 reopens and T4's provider-facing half is rewritten. If they do, T4's design is confirmed.
2. **Row 13, the Worker Loader cold path.** It is the load-bearing claim of criteria 7 and 8 and the
   one thing no local test can stand in for.
3. **Row 11, Access.** It is criterion 2 entirely, and the browser harness (T18) explicitly proves
   nothing about it.

Approving only these three is far cheaper than approving the whole gate, and it unblocks the
critical path.

## What stays true whatever you answer

- No paid spend happens until you say yes. Blocked is recorded as blocked; nothing is faked (D27).
- **Local container results from T20 are local container results.** They advance criterion 7's
  toolchain and reproducibility questions. They are not deployed Cloudflare evidence and this run
  will not record them as closing criterion 7 or 9 on their own. Astra was explicit about that trap.
- Criterion 10a no longer waits on the publication decision. Only 10b does.
