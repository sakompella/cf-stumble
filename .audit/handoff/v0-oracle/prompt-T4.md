You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T4   (branch work/T4, based on d6ff2380487a60f410c568272635d99f30560d14)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.md — read the "Dispatch contract" section and ONLY the section for T4.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E5-model-route-no-streaming.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E7-streaming-collapses-at-one-await.md

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

## Read the vendored Pi streaming helpers BEFORE you write any adapter

`vendor/pi-v0.84.4/index.ts` (around lines 33-40) exports `streamSimple`,
`createAssistantMessageEventStream`, and `createGatewayBindingFetch`. Evaluate all three and say in
your report which you used and why. Do NOT hand-roll a third adapter beside them without stating
what the existing ones could not do. `createGatewayBindingFetch` in particular may already solve the
Worker-binding transport problem.

## The true starting point - the roadmap understates it

The route has NO streaming interface at all, not a buffered one:
- `src/model-route.ts` - `ModelInference.run` returns `Promise<ProviderResult>` (one finished
  message); `ModelRouteResponse` carries one `AssistantMessage`; `ROUTE_MODEL` has
  `contextWindow: 0`, `maxTokens: 0`, `ZERO_USAGE`. Searching that file for `stream`,
  `ReadableStream` or any incremental event type returns nothing.
- `src/facet/generation-0/route-stream.ts` - `streamOnce` AWAITS the whole reply and pushes ONE
  event into a fresh `AssistantMessageEventStream`. It is a stream of one.

Read your task as "add a streaming interface across route -> facet -> RPC", not "carry existing
events". It is size L. E7 shows the ends already stream: `MainFacetTarget.startTurn` returns
`ReadableStream<Uint8Array>` and Pi's event stream type is already used. Change those two hops.
Do NOT rewrite the facet transport or the page.

## Keep these properties
- `FORBIDDEN_FIELDS` must keep blocking a client from overriding model, provider, endpoint,
  credentials or reasoning effort.
- `MODEL` and `REASONING_EFFORT` stay fixed. No model selection: outside the v0 cut line.
- `endedStream` / `failedStream` must still terminate the stream correctly when the model fails
  MID-stream, not only before it starts. Test a mid-stream failure explicitly.

## Paid clause lifted out of your task
T4.1's paid proof belongs to T1b, blocked awaiting owner approval. Build and test against a
deterministic fake provider. Where only a real Workers AI call can settle a behaviour - in
particular whether `{ stream: true }` yields incremental TOOL-CALL fragments as well as text deltas
- write the assumption down, mark it unverified, and keep the design able to survive the opposite
answer.

## Flag, do not fix
`ROUTE_MODEL.contextWindow: 0` and `maxTokens: 0` may make Pi compaction unreachable. If your work
shows that, write it in the report for T7. Do not change it here.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T4.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
