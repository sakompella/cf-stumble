You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T7   (branch work/T7, based on 638890ef8a8cd231f418306e0d0b9646f8531c66)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.approved.md — read the "Dispatch contract" section and ONLY the section for T7.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E9-wave2-preconditions.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E7-streaming-collapses-at-one-await.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E6-no-http-turn-surface.md

## Rules
- Read AGENTS.md and follow docs/agents/domain.md before you write code. Read the ADRs your task names.
- Apply the repo skills: typescript-best-practices for any .ts; agents-sdk and durable-objects for Supervisor, facet, thread or RPC work; cloudflare and workers-best-practices for bindings and Worker config.
- Stay inside your task's listed scope. Do not fix unrelated things you notice; list them in the report instead.
- Do not edit README.md. Do not create or edit GitHub issues. Do not push.
- `pnpm verify` is the gate: typecheck, format check, lint, tests, about 11s. Run it before you claim anything works.
- Delete obsolete code and its tests rather than leaving them unreachable. An unused safe path is a fault, not a safety net.

## No paid spend tonight
The owner is asleep and has not approved paid probes. Do NOT run `wrangler deploy`, create or start
any Computer workspace, call any billing Cloudflare API, or use the owner's account credentials.
If an acceptance criterion needs a paid environment, record it as **blocked: awaiting owner approval
for a paid probe** and prove everything else. Never fake, mock, or simulate a paid result to close a
criterion. `pnpm verify` runs locally in workerd and is always allowed.

## Three traps in this task, all confirmed. Read before you plan.

### 1. `git_diff` is NOT a duplicate tool. Deleting it breaks goal criterion 4.
The roadmap's earlier wording called for deleting "duplicate tools" with the buffered path. The diff
tool exists ONLY on that legacy path: `src/facet/generation-0/tools.ts:77` declares `git_diff`,
lines 92 and 138 map it to `{ kind: "git-diff" }`, and `tool-execution.ts:141-151` runs it. The Pi
path builds exactly four tools — read, write, edit, bash (`pi-agent-turn.ts:61-68`) — and has NO
diff tool. Goal criterion 4 and feature-map demo step 3 both require showing a diff, and T10/T11
consume it. So the Pi path must be able to produce a repository diff before that code goes, and the
frame byte budget must be large enough to show a small real diff without truncating it to
uselessness. Pi exports `truncateTail`; check what your frames do to a 40-line diff.

### 2. `vendor/pi-v0.84.4/index.ts` is GENERATED and the gate checks it.
Compaction is NOT exported today: `index.ts:30` exports only the `CompactionSummaryMessage` TYPE,
while the implementation lives in `packages/agent/src/harness/compaction/`. So you must widen the
export surface — but `tools/vendor-pi.mts` lists `index.ts` among managed generated files,
`checkVendorTree()` compares exact contents and SHA-256 sums, `SHA256SUMS` pins it, and
`verify:vendor` is the SECOND step of `pnpm verify`. Hand-editing `vendor/**` fails the gate by
construction.
Correct procedure: edit the generator's facade source, then run
`pnpm exec tsx tools/vendor-pi.mts --refresh-generated`. NEVER hand-edit `vendor/**`.
Do NOT attempt `--update`: it needs a clean upstream Pi checkout at tag v0.84.4 defaulting to
`/tmp/cf-stumble-pi-v0.84.4`, which this run cannot rely on.
A declaration-conformance check may reject an export that does not exist upstream. If so, record why
and choose a supported surface rather than forcing it.

### 3. Compaction may be unreachable even once exported.
`ROUTE_MODEL` in `route-stream.ts` declares `contextWindow: 0` and `maxTokens: 0`, with a comment
saying Generation 0 "has no way to learn the real values and must not invent them". Pi's compaction
trigger reads context-window numbers. Settle what Pi actually does with a zero window BEFORE you
claim goal criterion 5's forced-compaction test passes. If a real value is needed, say where it can
honestly come from; do not invent one.

## Scope note
T4 merged `638890e` and owns `model-route.ts`, `model-route-stream.ts`, `route-stream.ts` and their
tests. Coordinate through the merged interfaces; do not rewrite T4's streaming design.
E6: no HTTP route reaches any turn method. Building that surface is T9's work, not yours.

## Do not break what landed tonight
`pnpm verify` on main is 103 files / 698 tests, and `scripts/probe/clean-build.sh` produces two
identical maps (sha256 `8e821d86...`). Your changes are inside the facet, so the sha SHOULD move —
report the new one, and confirm the two builds still match each other.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T7.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
