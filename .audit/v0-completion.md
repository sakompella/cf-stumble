# v0 completion plan

Produced by an adversarial argument with Sol over two rounds, then verified against the tree.
Supersedes the sequencing in `.audit/autonomous-v0-plan.md`. Ignore `.audit/overnight-*.md`.

**Execution has moved to `.audit/v0-remaining-plan.md`.** That file is the live box-by-box
checklist for the remaining work. This file stays as the argument record, the run log, and the
owner-decision register.

## Definition of done

A real browser, behind Cloudflare Access, drives a locally running instance through: login gating,
a streamed Pi coding turn against a real Computer workspace, two projects proven isolated, a
passing candidate generation, activation, a broken candidate, rollback, and survival of thread and
project files. `pnpm verify` green at every commit.

## Settled by the argument

- Streaming is a direct cancellable SSE `POST`. Disconnect cancels the Pi `Agent`, kills and
  reconciles Computer executions, persists Pi messages, marks the turn cancelled or unresolved
  with no relay credit. No replay log, no `Last-Event-ID`, no background continuation. ADR-0037
  names background execution a separate choice and the feature map postpones resume.
- Two projects seeded from immutable configuration. One cannot prove routing or isolation.
- The project capability is a request-scoped RPC argument, never loader environment. The loader
  entry is cached per harness commit (`test/facet/loader.test.ts:143-170`), so a capability bound
  into `LOADER.get()` would leak whichever project populated the cache first. Only
  generation-invariant capabilities such as `MODEL` stay in loader environment.
- Per-project turn lease. Expiry marks the operation `unresolved` and never admits a second
  workspace-mutating turn until the prior execution is killed or reconciled.
- Compaction by selective export. `harness/nion/` does not exist, compaction is at
  `harness/compaction/compaction.ts` and `harness/session/context.ts`, and `index.upstream.ts`
  imports a dead path so it cannot be re-exported wholesale.
- GitHub delivery through a Worker-side broker, not credentials in the workspace. Verified:
  `GitPushOptions.onAuth?: AuthCallback` (`@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:466`)
  runs in the Worker isolate, while the shell-side `git` forwards argv with no auth callback.
  Requires amending ADR-0039.
- Ten of Pi's eighteen `ExecutionEnv` methods are reachable by its four exported tools, so the
  first real turn lands before the other eight. Verified reach: `absolutePath`, `readTextFile`,
  `readBinaryFile`, `writeFile`, `appendFile`, `fileInfo`, `canonicalPath`, `exists`,
  `createTempFile`, `exec`. Pi's `Agent`, agent loop, session context and compaction call no
  `ExecutionEnv` method. Seven of the unreached eight return `FileError("not_supported")`;
  `cleanup()` returns `Promise<void>` and cannot carry a `FileError`, so it is a resolving no-op
  (`harness/types.ts:283,313`). No operation method may ever throw or reject
  (`harness/types.ts:221-231`).

## Units

Each lands as one commit, ends with `pnpm verify`, and names its own check.

0. Align the decisions. `[offline]` Amend ADR-0039 for brokered delivery, record two immutable
   public projects, remove superseded buffered-session and no-egress text.
1. Repair the prior paid cleanup and the probe lever. `[approval]` Random run IDs, one-run
   enforcement, manifest-only deletion, explicit `--remote`, verified Worker deletion. Then check
   and remove `probe/probe-1788408728/module-map.json` and prove absence.
2. Enforce the owner in Worker code. `[offline]` Consume `CF_ACCESS_OWNER_SUB` and reject a valid
   non-owner before deriving any Durable Object name.
3. Correct the native Workers AI stream. `[offline, large]` Request streaming, parse the documented
   `choices` shape, bound output, calls, tools and time.
4. Implement the ten reachable `ExecutionEnv` methods. `[offline, large]` Chunked `exec`, abort,
   operation IDs, temp-output files, binary reads, canonical paths. Seven others unsupported,
   `cleanup()` a resolving no-op. The adapter is local to the tools' isolate because `bash.ts:64`
   reads `env.cwd` synchronously; `FileError` and callbacks cannot cross Workers RPC.
5. Replace the hand-written loop with Pi's `Agent`, deleting the buffered `ModelRoute.run()` drain
   left behind by unit 3. `[offline, large]` Wrap the four stock tools
   with `ExecutionToolContext`, adapt the model stream into Pi's event stream, expose a facet turn
   RPC taking a request-scoped `RpcTarget`.
6. Early real-turn checkpoint. `[approval]` One disposable workspace, one streamed Pi turn that
   reads, edits, runs a check, returns text. Stop if anything differs from the local contract.
7. Complete the other eight `ExecutionEnv` methods. `[offline]` No further tool registers first.
8. Two configured projects and project workspaces. `[offline, large]` Names derived from verified
   tenant plus server-resolved project ID, egress `direct`, managed `AGENTS.md`.
9. Persist one Pi thread per project. `[offline, large]` Durable Object `SessionStorage` holding Pi
   `AgentMessage` entries. Fresh thread preserves workspace files.
10. Add Pi compaction. `[offline]` Selective export, threshold via `transformContext`.
11. Project turn coordinator and direct SSE route. `[offline, large]` Lease, scoped capability,
    stream, save, credit only after terminal success plus durable save.
12. GitHub delivery broker. `[offline, large]` Exact-URL `onAuth`, generated branch, matching PR,
    no arbitrary remote/ref/base, no force or delete, idempotent retry.
13. Finish commit materialization. `[offline, large]` Labeled checkout, build twice, canonical
    bytes equal, no fixture in production.
14. Replace session routes with project routes. `[offline]`
15. Replace the page with the project UI. `[offline, large]` Sidebar, streamed rendering, fresh
    thread, generation controls. Verified by executing the script in a browser, not string matching.
16. Release driver and deployment procedure. `[offline]` Every external action single-use.
17. One disposable full rehearsal. `[approval]`
18. Deploy and record, then pause. `[approval]`

Nine engineering units are large: 3, 4, 5, 8, 9, 11, 12, 13, 15.

## Run log

- Goal set. Baseline `48544ef`, clean tree, 63 files / 428 tests green.
- Unit 2 dispatched to a `claude-sonnet-5` worker in an isolated worktree, 45 minute timebox.
- Units 3, 4, 5 briefs sent to Sol for review before any worker starts on them.
- Sol review completed. Unit 3 cannot start until an owner-approved probe captures one text stream
  and one fragmented tool-call stream from the pinned model. Unit 4 splits into a project-only
  capability protocol and a facet-local adapter. Unit 5 splits into provider-to-Pi adaptation and
  Dynamic Worker stream lifecycle.
- Sol review verified the four stock tools reach ten `ExecutionEnv` methods, including
  `createTempFile` and `appendFile` on the bash truncation path. The other seven filesystem
  methods must resolve `FileError("not_supported")`; `cleanup()` must resolve as a no-op.
- Unit 2 remains in an isolated `claude-sonnet-5` worktree. No commit is merged until its diff and
  its full `pnpm verify` result are inspected here.
- Unit 4A dispatched to a second isolated `claude-sonnet-5` worktree after Sol reviewed the
  boundary. It owns the narrow project-only RPC target and incremental Computer operation
  lifecycle; Unit 4B will own the facet-local Pi adapter after the facade prerequisite.
- Unit 2 merged as `2f3a7f7` after inspecting the worker diff. It consumes and validates
  `CF_ACCESS_OWNER_SUB`, rejects non-owners before Supervisor naming, wires local dev from the
  session subject, and adds focused rejection tests. Parent checkout `pnpm verify` passed with 64
  files and 434 tests. Next dependency is the reviewed Pi facade prerequisite.
- Sol's facade review completed. `AgentHarnessTool` is type-only at
  `vendor/pi-v0.84.4/packages/agent/src/harness/types.ts:81`; the new facade unit must export only
  runtime `FileError`, `ExecutionError`, `AssistantMessageEventStream`, and its factory, plus the
  exact required message/event types. The upstream barrel remains excluded because it references
  three missing renamed paths. The facade worker is running in its own `claude-sonnet-5` worktree.
- The facade worker merged as `8d08792` after its generated diff was inspected. Parent
  `pnpm verify` passed with 64 files and 438 tests. It exports only the required runtime Pi values
  and adds byte-for-byte generated-template drift checks.
- Sol found four defects in Unit 4A candidate `7b122b8`: no timeout, incomplete unknown-input
  parsing, symlink probes outside failure boundaries, and terminal records retaining heavy
  handles. A Sonnet correction worker is revising that candidate before merge.
- The first correction worker reached its 60-minute deadline after cherry-picking the candidate
  but made no edits or claims of verification. A fresh Sonnet worker now owns the four corrections
  with a 50-minute timebox and fake-timer acceptance tests.
- That fresh worker also stopped after the user pause with an unverified transitional tree and no
  correction commit. Its edits remain isolated and are not evidence. A new Sonnet worker has been
  dispatched from `main` with the same Sol-reviewed checklist and a clean 50-minute timebox.
- Sol's Unit 4B review exposed a deeper Unit 4A contract gap before that worker can merge. The
  project target must carry bytes, atomic write modes for append and create-exclusive, file metadata,
  canonical symlink outcomes, and granular typed failures. The adapter must implement only lexical
  `absolutePath`; `joinPath` is one of the seven unsupported methods. The active worker was told to
  stop or pivot before committing the narrower string/kind contract.
- That worker had already committed its prior correction as isolated `ec1e9f4` before the new
  review arrived. Its gate passed at 476 tests, but the commit remains deliberately unmerged because
  its string/kind contract cannot satisfy the revised byte/metadata/symlink requirements. A new
  revised Unit 4A brief is being reviewed before another Sonnet worker starts.
- Sol's revised Unit 4A review confirmed `provider.appendFile()` throws `ENOSYS` and
  `provider.realpath()` only normalizes lexical text. The implementation must use transactional
  provider descriptors for atomic writes and component-wise symlink resolution. A fresh Sonnet
  worker is implementing that byte-safe contract from `main`; old Unit 4A candidates remain
  unmerged.
- The byte-safe candidate `6332eb7` is also deliberately unmerged pending one direct contract
  check. Its `startExec()` awaits backend handle creation before allocating the operation or
  arming the timer, so a delayed `execBackend.exec()` can hang forever. Sol's acceptance requires
  timeout during delayed handle creation. A focused Sonnet fix worker is being sent against that
  candidate; the candidate's 502-test gate is not sufficient evidence for this race.
- Unit 4A is now merged as `464914e` plus delayed-start fix `79a9207`. The parent gate passed with
  71 files and 506 tests. Direct inspection confirmed byte payloads, atomic provider-descriptor
  writes, component-wise canonical paths, six-method reflection, operation timeout, delayed-start
  timeout, and late-handle disposal. Next dependency is the Sol-reviewed Unit 4B facet-local
  adapter.
- Sol's Unit 4B review completed. The adapter must live inside the facet, keep `joinPath`,
  `readTextLines`, `renameFile`, `listDir`, `createDir`, `remove`, and `createTempDir` explicitly
  unsupported, use the target's atomic write modes for append/temp files, map its nested canonical
  result, and return Pi's actual exec `Result` shape. Unit 4B is dispatched to a Sonnet worker with
  deterministic stock-tool, byte, symlink, event, abort and timeout tests.

### Sol review decisions for units 3 through 5

- Unit 3 must consume exact raw transcripts from the paid probe. It must not accept invented
  legacy and OpenAI shapes through a tolerant parser. Its normalized stream must be byte-oriented,
  cancellable by cancelling the returned stream, and bounded with explicit values.
- Unit 4 must not pass the public `WorkspaceHost` stub to a generation because that stub exposes
  `build`, `fetch`, and raw project operations. It defines a narrow project `RpcTarget` with
  command updates, operation IDs, timeout, and kill. The adapter is constructed inside the facet
  isolate because `env.cwd` is synchronous and Pi error values cannot cross RPC.
- Unit 5 must export the usable Pi runtime types through the generated facade, use sequential tool
  execution, preserve an eight-model-call bound, duplicate the workspace stub for a returned live
  stream, and keep only `MODEL` in the cached loader environment.

### Revised near-term order

1. Unit 2 owner enforcement.
2. Pi facade prerequisite: export only the runtime classes and event-stream/message types required
   by units 4 and 5, and update its generated conformance check.
3. Unit 4A project capability protocol and Computer operation lifecycle.
4. Unit 4B facet-local ten-method `ExecutionEnv` and stock-tool conformance.
5. Owner-approved stream-format probe.
6. Unit 3 implementation against the captured bytes.
7. Unit 5A model stream to Pi `StreamFn`, tool wrappers, state handoff and call bound.
8. Unit 5B Dynamic Worker turn RPC, stream cancellation, loader isolation and old-loop deletion.
9. Owner-approved early real-turn checkpoint.

### Sol acceptance corrections

- The stream-format probe must capture two raw transcripts, one text response and one forced tool
  call with incrementally arriving arguments, and must be limited to two inference calls. If the
  model emits the tool request as text with empty `tool_calls`, stop and reconsider the model.
- Unit 3 must expose a closed normalized event union and a byte-oriented cancellable stream. It
  must replay the captured bytes under arbitrary chunk boundaries, prove first-delta liveness
  before provider completion, cancel the upstream reader, and reject unknown shapes, malformed SSE,
  EOF without the observed terminal marker, invalid arguments, and unrequested tools.
- Unit 4 must define a narrow project `RpcTarget`; it must not pass `WorkspaceHost`, because that
  public stub exposes `build`, `fetch`, and raw project operations. Its command protocol must
  preserve incremental stdout/stderr and kill by operation ID. The stock-tool test must run in a
  tiny Dynamic Worker fixture, not only against a plain fake object.
- The Pi facade prerequisite must export runtime `FileError`, `ExecutionError`,
  `AssistantMessageEventStream`/its factory, and `AgentHarnessTool` plus the exact message/event
  types needed by units 4 and 5. Type-only exports are insufficient. `index.upstream.ts` remains
  excluded because it imports a missing `harness/nion` path.
- Unit 5 must duplicate the workspace stub for a returned live stream and dispose it on success,
  error, or cancellation. It must set `toolExecution: "sequential"`, retain the eight-model-call
  bound, and prove two project capabilities through one cached loader entry.
- The first Unit 4B worker committed `177d80d`, but its 553-test gate did not prove a real cross-isolate Dynamic Worker capability. Sol reviewed the gap and found that Loader `env` cannot carry a locally constructed `ProjectRpcTarget`; the supported test path passes the live `RpcTarget` as an RPC method argument to a Worker loaded through `env.LOADER`. Sol also found that object chunks cannot cross the Workers RPC stream boundary. A fresh Sonnet correction worker is converting exec events to newline-delimited JSON byte frames and adding the loaded-isolate stock-tool test. The candidate remains unmerged until the real workerd path passes or produces the specified stop evidence.
- The correction worker completed the RPC byte-stream portion as `dd0136b` on top of `18ef8d8`. Its focused checks passed with 558 tests, but it stopped before the required loaded-isolate fixture. The commit remains unmerged. A fresh Sonnet worker is now carrying both commits and implementing the real Worker Loader plus RPC-argument proof. It must either pass that workerd test or return the exact platform stop condition.
- Direct verification of `680692f` found a real test defect. After the loaded isolate edits `notes.txt`, the test still expected the host provider to contain the pre-edit bytes, so `execution-env-loaded.test.ts:119` failed with the actual `hello there` bytes versus expected `hello world`. The candidate remains unmerged. A fresh Sonnet worker is correcting the evidence to capture the pre-edit bytes before the edit and assert the post-edit bytes afterward, then will rerun the focused loaded-isolate test and `pnpm verify`.
- Sol adversarially reviewed everything after the plan baseline: `2f3a7f7`, `8d08792`, `464914e`,
  `79a9207`, and candidate `4146393`. Verdict was do not merge `4146393` and stop calling Unit 4
  complete. Three blocking defects and five warnings, written up in
  `.audit/adversarial-v0-review.md`. The candidate's loaded-isolate test is genuine evidence and
  its NDJSON framing is the right fix, but its chain has a red intermediate at `680692f` and its
  adapter repeats the host's command-lifecycle defect, so it can only land squashed and corrected.
- Two worker agents dispatched in parallel on disjoint file sets in separate worktrees, so neither
  could collide with the other. `gpt-5.6-terra` took `src/workspace/project/`; `gpt-5.6-luna` took
  `tools/`, `vendor/`, and `src/access/`.
- Branch `pi-agent-9b0cf8e7-e462-420` carries six commits fixing the exec lifecycle. EOF without an
  exit event and reader failures now kill the backend handle, stream `cancel()` routes through the
  same settle path and kills, the pump waits on `desiredSize` and resumes from `pull()` at a
  high-water mark of one event, every public method runs inside one `projectResult()` boundary that
  converts synchronous throws into `ProjectResult` failures, and there is an 8-operation cap plus a
  65,536-byte command cap. `pnpm verify` green at 71 files and 512 tests, run in the parent
  checkout, not taken from the worker's report.
- The lifecycle tests were verified as real regression tests, not assertions fitted to existing
  behavior. Reverting the `cancel()` handler and both `killBackend` flags made exactly three tests
  fail with `expected +0 to be 1`, then restoring made them pass.
- `a0cb7f4` on that branch fixes a defect the worker introduced. It inserted `resumePump()` directly
  beneath the JSDoc block documenting `settle()`, leaving a comment about terminal events and
  fire-and-forget kills attached to a three-line wakeup helper.
- Branch `pi-agent-3c026af1-e506-4e9` carries two commits. The Pi declaration conformance check now
  compiles the facade against the vendored upstream barrels instead of against a second copy of its
  own generated string, and `configuredOwnerSubject()` trims once at the boundary so a secret with a
  trailing newline no longer yields `not-owner`. The `index.upstream.ts` renames are pure renames,
  every `SHA256SUMS` line unchanged apart from the filename. `pnpm verify` green at 71 files and 507
  tests.
- The conformance check was verified with an independent mutation beyond the worker's own. Aliasing
  a different type behind a correct name, `export type { AgentState as AgentOptions }`, failed the
  build with TS2344, so the comparison is structural rather than name-only.
- That check is still partly tautological and the worker did not report it. Five of thirteen export
  groups are byte-identical between `piFacadeSurfaceSource` and `piUpstreamSurfaceSource`, so they
  compare a source module against itself. Three of the five are new, created by repointing the
  facade at the barrel to make the two sides agree. The agent was resumed to either restore the
  facade's deep paths or name the symbols the check cannot verify independently.
- Decision: the lifecycle fix deliberately left `ReadableStream<ExecEvent>` unchanged, so the byte
  framing lands as its own unit on a green base rather than mixing two large changes in one diff.
- Decision: an `exit` event does not kill the backend handle, because it is the backend's
  affirmative signal that the process already ended. EOF without exit and read failures carry no
  such guarantee, so they kill.
- Decision: neither branch is merged into `main`, which stays at `79a9207` pending the owner
  decisions below.
- Residual defects, none of them merged-blocking on their own. Backpressure bounds the queue at one
  event rather than at a byte count, so a single very large stdout chunk still lands whole in
  memory. The candidate's facet adapter still concatenates full `stdout` and `stderr` strings, which
  undoes the host-side bound one hop later and must be fixed during the port. `projectResult()` maps
  every throw through `mapProviderError`, so a genuine bug in our own code now surfaces as
  `backend-unavailable` with no observability hook. The new `too-many-operations` code has to be
  added to the facet adapter's mapping when 4B is ported.
- Correction to the session record. I claimed in one reply that I had resumed the conformance agent
  to close the residual self-comparisons. I had not; no such call was made at that point. It was
  made afterwards. Recorded here because the run log is the thing later sessions trust.

- The Pi facade on `main` resolves `AgentMessage` to plain `Message`, dropping the four harness
  variants. `packages/agent/src/types.ts:326` defines `AgentMessage` as `Message |
  CustomAgentMessages[keyof CustomAgentMessages]`, and `CustomAgentMessages` is empty until the
  `declare module` block at `packages/agent/src/harness/messages.ts:54` augments it with
  `bashExecution`, `custom`, `branchSummary`, and `compactionSummary`. That augmentation only
  applies when `harness/messages.ts` is in the compiled program, which the upstream barrel pulls in
  and the deep paths do not. A type probe against `main` resolved `Extract<AgentMessage, { role:
  "bashExecution" }>` and the `compactionSummary` equivalent to `never`; the same probe against
  `pi-agent-3c026af1-e506-4e9` resolved both. The harness emits those messages as soon as the bash
  tool runs or compaction fires, so Unit 9 session persistence would be typed against a message
  union that excludes real traffic.
- Decision: make the augmentation explicit rather than let it ride in as a side effect of an import
  path. The facade will name the four harness message types in its exports and restore deep paths
  for the agent type group, which fixes the types and restores the conformance check's independence
  for those groups in one move. The worker stopped and reported the disagreement rather than
  papering over it, which is what the brief asked for.
- `packages/ai/src/index.ts` does not re-export `streamSimple`, `createGatewayBindingFetch`, or
  `AiGatewayBinding`, so those three have no independent second source in the vendored package and
  the conformance check cannot verify them. That limit will be named in a comment rather than
  hidden.
- Repo state observation, cause unknown. `origin/main` now equals local `main` at `79a9207`, so all
  47 commits are on GitHub. This clone's reflog records its last real push on 2026-08-31 at
  `5c61d57`; today at 17:54 a `fetch` fast-forwarded the tracking ref, so the remote already held
  `79a9207` from another clone or a manual push. No `.github/workflows` exist, so nothing deployed.

- `6c13393` on `pi-agent-3c026af1-e506-4e9` implements the explicit-augmentation decision. The
  facade names `BashExecutionMessage`, `CustomMessage`, `BranchSummaryMessage`, and
  `CompactionSummaryMessage` from `harness/messages.ts`, and the deep paths are restored for the
  agent type group and `ExecutionToolContext`. Verified independently: my own `Extract` probe now
  resolves all four variants through the facade, `pnpm verify` passes at 71 files and 507 tests in
  the parent checkout, and a diff of the two generated surfaces leaves exactly three identical
  lines, `streamSimple`, `createGatewayBindingFetch`, and `AiGatewayBinding`, each named in a
  generator comment as having no independent barrel source. Down from five self-comparisons, and
  the three the worker had introduced are gone.

- Owner answered question 9. He pushed `main` to `origin` himself, so the remote holding `79a9207`
  is expected and nothing else has write access. Question closed.
- Owner added a GitHub App to `.env`, exposing `GITHUB_APP_ID` and `GITHUB_CLIENT_ID` alongside the
  existing `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_STUMBLE_HOSTNAME`. He is unsure whether
  it is needed. It is directly relevant to unit 12, since a GitHub App installation token is a
  cleaner source for the broker's `onAuth` callback than a personal token, and it bears on open
  decision 1 about amending ADR-0039. No secret values were shared and none belong in this file.

- Owner said to continue and to operate as an orchestrator, so open decisions 4, 5, and 6 were
  taken rather than left waiting. Both verified branches merged into `main` as `171ce23` and
  `959e0ac`; `pnpm verify` green at 71 files and 513 tests after the merge. `main` now carries the
  fixed exec lifecycle, the caps, the never-reject boundary, the honest Pi conformance check, the
  facade message types, and the owner-subject trim. The approval-gated items are untouched.
- A pi-goal was set for the remainder of v0. Its verification surface is `pnpm verify` plus the
  seven browser scenarios in the Definition of Done, and its stop condition requires reporting
  evidence, attempted paths, blocker, and the exact owner input needed.

- Three scoped explorer subagents mapped the tree at `959e0ac` and several findings contradicted
  this file's unit descriptions. The workspace has never been wired into a turn (`WORKSPACE` is
  optional at `src/facet/generation-0/capabilities.ts:26-37` and production mounting never supplies
  it at `src/supervisor/artifacts/index.ts:88-109`). No project concept exists; routes are
  session-shaped and `PROJECT_WORKSPACE_NAME` at `src/workspace-names.ts:6` is an unused string.
  Egress is still `none`. Nothing in the turn path streams and it buffers in four places. Page tests
  parse the client script with `new Function` rather than executing it. The build workspace assumes
  a `/harness/.git` that nothing provisions. Recovery performs no rollback itself.
  `scripts/probe/run.sh` remains unsafe to run.
- `.audit/v0-remaining-plan.md` written as the live execution checklist, thirteen phases A to M with
  dependencies, named evidence, and completion tests. It passes the portable plan validator with 0
  problems. This file keeps the argument record, run log, and owner-decision register.
- Sol cross-checked the phase A port plan before dispatch and changed it in five ways. The biggest:
  do not port the candidate's `TransformStream`, because it inserts a second queue that produces
  two upstream reads with no consumer and defeats the one-event bound at
  `test/workspace/project/exec-lifecycle.test.ts:157-180`. Frames must be encoded inline before
  `controller.enqueue()`. Sol also found that dropping full output accumulation conflicts with
  `ExecutionEnv.exec`'s contract at `vendor/pi-v0.84.4/packages/agent/src/harness/types.ts:303-310`,
  so the decision taken is to bound output with Pi's own truncation helper rather than invent one.
- Phase A dispatched to a `gpt-5.6-terra` worker in an isolated worktree with those corrections.
  Sol is separately cross-checking the whole plan, including whether phase D can be built against
  captured fixtures so the blocked paid approval stops gating five phases, and whether the done
  predicate's JSON evidence file can be forged by the agent it polices.

- Sol rejected plan revision 1 as an execution sequence and the plan was rewritten as revision 2.
  Five findings. The old phases B and D formed a dependency cycle: B promised a request-scoped RPC
  argument, but the RPC method able to receive one is created by D, while D declared all of B as a
  prerequisite. Commit materialization was placed late but depends only on build-workspace
  provisioning and outbound access, and must precede every real candidate because submission
  already invokes the cache-miss builder at `src/routes/generations.ts:153-176` while
  `/harness/.git` does not exist. Several phases hid two or three deliverables. Several named
  evidence items would pass while the behaviour stayed broken. The seven scenarios were counted
  rather than named.
- The most valuable finding: the paid probe no longer gates five phases. Pi's `Agent` accepts an
  injected `StreamFn` at `vendor/pi-v0.84.4/packages/agent/src/agent.ts:98-103,216-238`, and
  `createAssistantMessageEventStream` supports deterministic synthetic streams
  (`test/vendor/pi.test.ts:104-135`), so the Agent core, tools, state handoff, sequencing and call
  bound can all be built and tested against synthetic Pi events. Only the provider decoder needs the
  captured bytes. Sol was explicit that inventing provider wire fixtures is not allowed as a
  substitute.
- Sol corrected two things in revision 1. Recovery performing no rollback is intentional under
  ADR-0032, not a defect, and manual rollback already exists at
  `src/supervisor/control/index.ts:136-167`. The materialization citation belongs at
  `src/harness-build.ts:20-23,61-75`, verified as the file declaring `harnessGitDir: "/harness/.git"`.
- The done predicate moved out of the repository. Revision 1 read a JSON report under `.audit/`,
  which is gitignored and writable by the agents the predicate polices. Replaced with an
  owner-controlled runner outside the tree that executes the seven live scenarios and exits nonzero
  itself.
- New owner question recorded: are the remaining eight `ExecutionEnv` methods and the GitHub
  delivery broker in v0 at all? Neither appears in the Definition of Done, and Sol argues neither
  should gate release unless the owner expands scope. Answering no shortens the programme
  materially.

### Unit 3 is blocked on an ungrounded wire format

The streamed chunk shape for the pinned model `@cf/zai-org/glm-5.3-flash` is not documented
anywhere I can reach, so fixtures written offline would be invented:

- `https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/streaming-output.json`
  returns exactly `{"type":"string","contentType":"text/event-stream","format":"binary"}`.
  Cloudflare publishes no chunk payload schema for this model.
- `.audit/research/workers-ai-glm-5.3-flash.md` documents only the synchronous OpenAI-style
  shape (`choices[].message`, `finish_reason`), never a streamed chunk.
- Public sources conflict. Cloudflare's streaming blog post shows legacy `data: {"response":...}`;
  the model's synchronous schema implies `choices[].delta`. `cloudflare/ai` issue 574 reports
  `@cf/openai/gpt-oss-*` leaking forced tool calls into `message.content` with empty `tool_calls`
  and `finish_reason: "stop"`. PR 396 mentions silent empty responses when streaming some models
  via `/ai/run/`.

Tool-call streaming is exactly where the candidate shapes diverge. Awaiting Sol's ruling between
a tolerant strict-validating parser, one owner-approved paid probe to capture real bytes, or
reordering unit 3 after the approval-gated probe. Note `wrangler dev`'s AI binding bills the real
account, so even local AI testing is paid.

## Open owner decisions

1. Amend ADR-0039 to move the GitHub credential out of the workspace into a Worker-side broker?
   The alternative Sol first proposed was deleting push entirely.
2. Both seeded repositories must be public, secret-free, and free of privileged push workflows. A
   same-repository workflow running agent-modified scripts with repository secrets would defeat
   the no-secret guarantee even with the GitHub token hidden.
3. Disconnect cancels a running turn and the work is lost. Confirm that is acceptable for v0.
4. Port the candidate's NDJSON framing onto `pi-agent-9b0cf8e7-e462-420` as one squashed commit and
   delete the four-commit chain? The chain cannot merge intact because `680692f` is red. My
   recommendation is yes, since the framing is already proven across a real workerd isolate and
   rewriting it buys nothing. The port must also kill the operation on a malformed frame, unknown
   event, rejected stream, or premature EOF, and must drop the full-output accumulation.
5. Split the workspace barrel before that port, so the Worker-safe project protocol has an entry
   point free of Computer and Node imports? Today `src/workspace/project/index.ts` sits behind the
   same barrel as `WorkspaceHost`, which is why the candidate duplicates `MAX_EXEC_TIMEOUT_MS`. That
   barrel just grew two more exported constants, so the pull toward duplication is getting stronger.
   My recommendation is yes, and before the port rather than after, because both touch the same
   files and Unit 5 hits the same wall.
6. Merge the two verified branches into `main` now, or hold them until the port is ready? Holding
   keeps `main` at a state whose advertised RPC surface cannot cross an isolate. Merging makes
   `main` correct in every respect except the stream type.
7. Approve exactly two Workers AI inference calls against `@cf/zai-org/glm-5.3-flash` to capture one
   text stream and one fragmented tool-call stream? Unit 3 cannot start without them and the
   fixtures would otherwise be invented. Note `wrangler dev`'s AI binding bills the real account.
8. Should an unexpected internal throw be observable rather than silently mapped to
   `backend-unavailable`? The never-reject contract forces the target to swallow it, so without a
   counter or a log line a real bug in our code is indistinguishable from a backend outage.
9. Did you push `main` to `origin`? All 47 commits are on GitHub and this clone did not push them.
   If it was not you, something else has write access to the repository and that is worth knowing
   before any credential work in units 0 and 1.
10. Should Unit 9 session persistence serialize the four harness message variants (`bashExecution`,
   `custom`, `branchSummary`, `compactionSummary`), or store only the base `Message` union and drop
   harness-generated entries on reload? Making the facade types correct forces this choice into the
   open rather than leaving it to a silent type mismatch.
