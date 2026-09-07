# Morning brief — cf-stumble v0 overnight run

Read this first. Detail lives in `.audit/v0/`: `STATE.md` (live state), `decision-log.md` (D1-D38),
`questions.md` (what needs you), `evidence/E1-E9` (findings confirmed from source),
`review-opus-round1.md` (adversarial plan review), `acceptance-checks.md` (how I judge workers).

## What you asked for, and what happened

You asked for a `gpt-6-astra` architecture critique and a v0 roadmap, reviewed by `gpt-5.6-sol`,
then all work delegated to subagents.

- The oracle ran on `gpt-6-astra` (forced through `prime-agent`, as you said) and delivered a
  critique, a 12-task roadmap, a goal, and six product questions.
- The goal is SET (id `c0552403`): ten measurable done-criteria and an explicit cut line in
  `.audit/v0/goal.md`.
- `gpt-5.6-sol` could NOT run: Codex quota exhausted until 05:57, `prime-inference` 401
  unauthenticated, `opencode` 401 no payment method. Review round 1 ran on `claude-opus-5` instead;
  the sol round is queued for after 05:57. See D14, D16, D17.
- Review verdict: SHIP WITH FIXES. It independently reached the same dispatch decisions I had
  already made, which is the strongest signal available that the plan is sound.

## The five things that actually block v0 (confirmed from source, not from the oracle's report)

1. **E1** The Supervisor cannot build a labeled commit from clean state. `harness-build.ts:30` runs
   `build:module-map` alone, but the vendored Pi `dist/` is untracked and only `build:pi` creates it.
   Local `pnpm verify` hides it by running `build:pi` first. Blocks criteria 7 and 8.
2. **E6** No HTTP route reaches `startProjectTurn`/`finishProjectTurn`/`abandonProjectTurn`/
   `streamProjectTurn`. The coding half of v0 is unreachable from a browser. Blocks criteria 4, 5, 6.
3. **E2** Turn lease fencing is dead code: the `*WithLease` methods have zero callers and zero tests,
   and the client surface has no parameter to carry a lease id. Blocks criterion 6.
4. **E3** Three surviving encodings of the pre-ADR-0038 layout: the container name hashes
   `project.id`, a separate tenant-blind build container, and `PROJECT_ROOT = "/project"` defined
   TWICE — the second copy being the path-escape guard. Blocks criterion 3.
5. **E4** `ProjectCatalog` is a fixed two-tuple TYPE, so no runtime connect flow can add a project.
   Blocks criterion 3.

Two findings went the other way and made the plan cheaper: **E7** (streaming already exists on both
sides; one await collapses it, so T4 is narrow) and **E8** (Computer container behaviour is already
paid-verified, so T1b must not re-buy it).

## What ran overnight

Five workers, each in its own git worktree, each gated on `pnpm verify` passing AND writing a
report — a worker cannot finish by asserting success.

| task | model | what |
|---|---|---|
| T1a | opus-5 | clean-build fix + the regression proof the review demanded |
| T2 | sonnet-5 | delete generation request journaling (ADR-0030) |
| T4 | sonnet-5 | streaming interface across route -> facet -> RPC |
| T5 | opus-5 | lease fencing, tier raised from the roadmap's sonnet |
| roadmap | opus-5 | apply the review's fixes -> `roadmap-v0.approved.md` |

T3 was held back deliberately: it is the largest critical-path task and collides with T5 and T6.

## What needs YOU (in `.audit/v0/questions.md`)

**Q7 is the blocker.** Eight tasks spend money or touch your accounts, including T8 (an R2
**deletion** lifecycle rule on a real bucket) and T12 (deploy + publishing a recording — the only
step with irreversible disclosure). I need:
1. a NAMED non-production account, or a run prefix for Worker names, R2 bucket, DO namespaces and
   Container;
2. a spend cap, with stop-on-first-paid-failure;
3. which DISPOSABLE GitHub repos under a throwaway owner probes may clone and push to;
4. the bucket T8's deletion rule may act on;
5. Q5: where the recording may be published.

**Cheapest useful approval:** a five-minute probe of
`env.AI.run("@cf/zai-org/glm-5.3-flash", { stream: true, tools: [...] })`. If tool-call fragments do
not arrive incrementally, Q6 reopens and T4's provider-facing half is rewritten.

**Q6 deserves a look.** The code pins `@cf/zai-org/glm-5.3-flash` at `reasoning_effort: "low"`, while
`.audit/design-questions.md` records a preference for OpenAI. Low effort on a flash model is also a
coding-quality risk for the criterion-4 demo turn.

Q2-Q5 have reversible defaults already applied; flip any of them freely.

## What actually landed on main

Three tasks merged, each gated on `pnpm verify` that I ran MYSELF, not on the worker's claim.
Main is now **96 test files / 658 tests** green, up from 93/642.

| commit | what | proof |
|---|---|---|
| `567d25e` T5 | finish and abandon now REQUIRE the admitting lease | 7/7 objective checks; new 173-line `turn-lease.test.ts` |
| `c3e0d5a` T2 | ADR-0030 cleanup: no request ids, fingerprints or journal; epochs intact | 4/4 objective checks; 36 files, +386/-663 |
| `d1f2412` T1a | a labeled harness commit builds from a clean checkout | 5/5; I ran the probe myself |

**E1 is closed and I proved it rather than believing the report.**
`scripts/probe/clean-build.sh` exits 0 and two independent clean `git archive` checkouts produce
byte-identical module maps, sha256 `387ed749...`, 905270 bytes. The same operation previously failed
with five `Could not resolve "@cf-stumble/pi"` errors. It also measured the cold-store numbers the
review demanded: 13 s per build, 491M build directory, **598M cold store** — a container disk-budget
warning for T1b.

T5 also did better than the design I gave it: instead of migrating callers onto the `*WithLease`
methods, it collapsed the duplicate pair entirely, so there is now ONE method set in which the lease
is mandatory. Two of my objective checks failed against that better solution; I fixed the checks,
not the work.

## Honest status

Three of the five confirmed blockers are closed (E1, E2, and the ADR-0030 cleanup). Two remain
untouched (E3 workspace layout, E4 catalog type), plus E6 — criterion 4 still needs an HTTP turn
surface that does not exist at all. Of your ten done-criteria: 6 and 8 advanced, 7's local half is
proven, and 1, 2, 3, 4, 5, 9, 10 are untouched. **v0 is not close.** No money was spent.
Still running when I wrote this: T3a (shared workspace migration) and T4 (streaming interface).


## If you find work sitting unfinished

Workers write to `/tmp/cf-stumble-wt/<id>` (branch `work/<id>`) and report to
`.audit/v0/tasks/<id>.md`. If a worker finished but nothing merged it, the branch and report are
intact and `STATE.md` has the full procedure: run the objective checks, read the report and diff,
then `git merge --no-ff work/<id>` and `pnpm verify` — gating between every merge, in the order
T3a before T4. After any merge also re-run `scripts/probe/clean-build.sh`, because `pnpm verify`
runs `build:pi` first and so hides exactly the fault E1 described.
