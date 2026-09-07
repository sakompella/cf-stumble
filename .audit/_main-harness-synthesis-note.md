# Synthesis note: main harness implementation plan

Four candidates, one prompt, separate output directories. No dropouts. Runners were
`claude-opus-5` (1), `gpt-5.6-sol` (2), `claude-sonnet-5` (3), `gpt-5.6-terra` (4). Cross-judge was
`gpt-5.6-sol`, a different family from the parent, which weakens its independence from candidate 2
and is recorded here as a caveat on the agreement.

## Base

**Candidate 2.** I scored it 27/30, the cross-judge 26/30, and we picked it independently.

My first pass put candidate 1 on top. Checking its ADR-0034 handling against the ADR text
overturned that. ADR-0034 says a cache miss asks Computer to rebuild the map from the labeled
commit; candidate 1 returns a problem code instead and does not name the conflict, while also
letting the harness hand the Supervisor module-map bytes for a commit it claims. Both weaken the
rule that the commit is the authoritative description of executable code. That is the failure the
rubric weighted hardest, and I had missed it by reading the plan's stated intent instead of its
mechanism.

Candidate 2 wins on extension safety rather than on insight count. Its opaque compare-and-swap
document store lets the generation own the session schema and every migration of it, while the
host stays a dumb durable key-value surface. Executable identity, session evolution and recovery
evidence each stay on the correct side of an authority boundary, so a maintainer can change one
without reaching into the others.

## Convergence

All four independently chose facet-hosted Pi with `globalOutbound` as the sole egress route, and
all four rejected `AgentHarness` as unusable in 0.84.4. That agreement is strong and the plan ships
the consensus shape without further argument.

## Grafts

**From candidate 1.** The Computer acquisition plan, which is blocking and which candidates 2, 3
and 4 all missed: npm `latest` is `0.2.1`, and `@cloudflare/dofs` and `@cloudflare/computer-rpc`
are unpublished, so the ADR-0026 pin exists only as source and must be built and vendored as dist.
Also its vendoring mechanism, which is the only correct one of the four: `tsc` follows imports, so
a vendored tree must be a workspace package emitting `dist` rather than a directory excluded from
`include`. Also the pin test binding the Pi commit, the Computer commit and the image digest
together.

**From candidate 4.** The `inspect` / `modify-harness` tool split, which enforces "change the
harness only on explicit request" through which tools exist in the turn rather than through prompt
text. A shell command cannot be made read-only by inspecting it. Also making slice 1 a pure paid
probe that can disprove the whole path before any product code exists.

**From candidate 3.** Exactly one `index.ts` per vendored tree, because `module-seams.test.ts`
enforces seams per directory containing one and deeper files would make Pi's internal imports read
as violations. Also the day-boxed stop condition on the vendoring slice.

## Rejections

**Candidate 1's R2 cache-miss behavior.** Returns a problem code where ADR-0034 requires a Computer
rebuild, and does not flag the conflict. Rejected outright.

**Candidate 1's harness-supplied module map.** `submitGeneration(requestId, commit, moduleMap)` has
mutable code providing the executable bytes for a claimed commit. The commit is supposed to be the
authority; the Supervisor rebuilds from it.

**Candidate 1's tail-byte sentinel.** Detects truncation, but is unscoped, so any streamed non-turn
response becomes false failure evidence. The route-qualified incremental parser with a matching
turn id, which candidates 2 and 4 converged on, is strictly better.

**Candidate 3's decision to leave `bodyOutcome` alone.** It names the defect clearly, then builds an
acceptance test that asserts `body-completed` on a path it has already shown is unable to tell
completion from truncation. Planning to ship evidence you know is false is worse than not producing
the evidence.

**Candidate 3's vendoring mechanism and capability route.** `exclude` does not stop `tsc` checking
imported files, and `proxy.ts` states plainly that DO namespace references are not clonable through
loader env. Both would have failed at slice 2.

**Candidate 4's Pi JSONL session backend.** Pi's JSONL storage leans on atomic rename for
publication, and pinned Computer has no native rename. The CAS document store avoids the problem
rather than working around it.

**The loop and PR checklist scaffolding in candidates 2 and 4.** It cites `skills/poteto-mode/...`
paths that do not exist in this repository, so a fresh agent executing the plan would hit missing
commands in its first step.

## Verification

`.audit/verify-harness-plan.sh` re-runs every load-bearing citation in the plan: the two clone
commits, the Pi API shapes, the two-file `node:` boundary, the container and proxy constraints, the
missing rename, the three npm 404s, the relay defect, the retained-artifact defect, and the ADR
text the plan depends on. 27 checks, all passing. The repository itself is unchanged; nothing
outside `.audit/` was touched.

What the script cannot prove is anything requiring a paid deployment: whether the Pi bundle loads
in a real Dynamic Worker, whether the `ctx.exports` proxy survives loader cloning on the target
account, and whether a multi-tool turn fits the facet's limits. Slice 1 exists to settle exactly
those before product code is written.
