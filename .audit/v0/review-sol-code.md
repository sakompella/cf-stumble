# Sol review: merged v0 code at `7818f8d`

Reviewed against `d6ff238`. I read the merged code, the v0 state, decisions D1-D69, questions, goal,
acceptance checks, all task reports, and both prior Opus reviews. I changed no tracked file.

## Verification

- `pnpm verify`: **green**, 117 test files and 841 tests. The required gate is green.
- `pnpm harness:browser`: **red**. It exits with `ERR_MODULE_NOT_FOUND` for
  `tools/browser-harness/run.mts`. The manifest advertises that missing entry point at
  `package.json:21`, and the repository tells maintainers to read a missing README at
  `AGENTS.md:23-25`.
- No paid probe was run. Q7 remains open.

## Findings, ranked by leverage

### 1. A turn can outlive its lease and keep changing the shared workspace

**What is true.** The four-minute limit is applied twice, once to start and then afresh to the
stream, even though the admitting lease lasts five minutes. A timed-out start is not cancelled.

**Evidence.** Admission starts the lease before `boundedStart` at
`src/supervisor/projects/turn-run.ts:133-146`. `boundedStart` races a timer but neither passes an
abort signal nor cancels the losing start at `src/supervisor/projects/turn-run.ts:169-183`. A
successful late `startTurn` starts the facet pump eagerly at
`src/facet/generation-0/facet-turn.ts:96-124`. If start wins, the stream installs another complete
`deadlineMs` timer at `src/supervisor/projects/turn-stream.ts:145-171`. The constants are five and
four minutes at `src/supervisor/supervisor.ts:85-110`. After lease expiry, admission explicitly
allows a replacement at `src/supervisor/threads/decisions.ts:20-57`.

**Cost.** An old turn can continue tool effects after a replacement turn owns the same project. T5
fences the old thread save, but it cannot undo concurrent edits in T3a's one shared workspace. This
is data-corruption risk, not only stale accounting.

**Do.** Create one absolute deadline at admission. Pass its remaining budget and one cancellation
signal through mount, provision, facet start, and stream read. Cancel a late start result before
releasing its lease.

### 2. The page silently discards the harness-owned diff

**What is true.** T13 emits `diff` and `diff-unavailable`, but merged T10 handles neither.

**Evidence.** The protocol declares both frames at
`src/supervisor/projects/turn-frames.ts:35-65`, and the facet emits one before its terminal frame at
`src/facet/generation-0/facet-turn.ts:62-69`. The page handles only text, tool-start, and tool-result,
then ignores every unknown nonterminal frame at `src/page/script-turn.ts:86-109`. Its claimed
vocabulary test omits both diff kinds at `test/page/owner-page.test.ts:78-96`.

**Cost.** Goal criterion 4 is impossible in the merged page. The server does the work and the owner
never sees it.

**Do.** Merge a page-only renderer for both frames and make the test exhaustive from a shared frame
kind definition, rather than a copied string list.

### 3. Generation attribution is sampled after the generation has been chosen

**What is true.** A turn can run on generation A but record its relay attempt and completed-turn
credit against generation B.

**Evidence.** The mount reads the then-current active generation at
`src/supervisor/supervisor.ts:388-399`. The caller awaits all start work first at
`src/supervisor/projects/turn-run.ts:143-156`, then samples attribution when it creates the attempt
at `src/supervisor/projects/turn-run.ts:194-207`. An activation during mount, provisioning, or facet
start separates those two reads.

**Cost.** Known-good evidence and completed-turn history can be assigned to code that did not serve
the turn. Rollback decisions can therefore use false evidence.

**Do.** Snapshot `{active, preparationCheckId}` once after admission. Use that same snapshot to mount
the facet and create the attempt.

### 4. Model failures and rejections count as known-good responses

**What is true.** The credit split is conceptually right, but `servedSuccessfulResponse` does not
mean what its name and comment claim.

**Evidence.** `rejected`, `failed`, and `completed` terminal frames all settle as
`body-completed` at `src/supervisor/projects/turn-settle.ts:133-140`; the attempt already has HTTP
200 at `src/supervisor/projects/turn-run.ts:200-207`. `servedSuccessfulResponse` accepts every
`body-completed` response below 400 at `src/supervisor/eligibility.ts:165-174`, and eligibility
counts those at `src/supervisor/eligibility.ts:131-149`.

**Cost.** Three model-error turns over the configured span can make a generation eligible even if it
never completed useful work.

**Do.** Preserve the split, but give terminal rejection/failure a non-crediting relay outcome, or
record the proven terminal kind and require `completed` in `servedSuccessfulResponse`.

### 5. T10 advertises browser evidence that was never committed

**What is true.** The task report was merged while it still said “browser harness in progress”. The
commit adds the command and documentation, but no `tools/browser-harness/` files.

**Evidence.** `package.json:21` points to `tools/browser-harness/run.mts`; `AGENTS.md:23-25` says the
command drives Chromium and points to its README. Neither path exists at `7818f8d`, and the command
fails. Static page tests cannot replace this: the page is an assembled inline script, as the T10
report itself concedes, and `test/page/owner-page.test.ts:78-101` only searches its source text.

**Cost.** The stated UI verification procedure is broken. Keyboard, viewport, live streaming, and
second-browser behavior have no runnable evidence.

**Do.** Recover and commit the harness and run it. Add a cheap tracked-file existence check to the
normal gate so a manifest command cannot point to an omitted tree again.

## 1. Seams

**Verdict: the three seams agree as a design, but do not yet hold as one safe implementation.**

T3a makes the workspace server-derived and tenant-wide: the Supervisor derives one name at
`src/supervisor/supervisor.ts:127-153`; the turn resolves a server catalog project, uses its selected
directory, and receives only the tenant capability at
`src/supervisor/projects/project-turn.ts:77-127`. T9b makes the browser provide only project id and
prompt at `src/routes/turns.ts:7-17,61-103`, while the Supervisor owns admission, history, lease,
save, and credit at `src/supervisor/supervisor.ts:341-369`. T13 then runs the diff through that same
leased project capability and working directory at
`src/facet/generation-0/facet-turn.ts:35-69`. These are compatible authority boundaries.

The lifetime bug in finding 1 breaks their composition under timeouts: centralizing all repositories
in one workspace increases the damage from an orphan turn. The attribution race in finding 3 also
breaks T9b's claim that one admitted turn stays attached to the generation that served it.

## 2. The credit split

**Verdict: it answers the two different questions structurally, but only the completed-real-turn
predicate answers its question correctly.**

There is one caller of `servedSuccessfulResponse`, the eligibility derivation at
`src/supervisor/eligibility.ts:120-149`. There is one production caller of
`earnsCompletedRealTurnCredit`, immediately after a lease-fenced save at
`src/supervisor/projects/turn-settle.ts:78-100`.

`earnsCompletedRealTurnCredit` requires Pi terminal success, a committed thread save, and a
non-failed/non-cancelled delivery at `src/supervisor/eligibility.ts:176-201`. At its only caller the
attempt can still be `pending`, because settlement follows synchronously at
`src/supervisor/projects/turn-stream.ts:162-170`; there is no `await` in between. That works today,
but settling first and evaluating the settled record would make the contract less temporal.

The other predicate over-credits terminal failures and rejections, as finding 4 shows. The correct
fix is not to reunify the predicates: storage failure should remain separate from harness health.
The relay evidence needs one more fact about the terminal outcome.

## 3. The lease

**Verdict: no thread finish or abandon write without the admitting lease exists.**

`ThreadStore.finishTurn` requires `leaseId` and checks it inside the storage transaction at
`src/supervisor/threads/store.ts:140-179`; `abandonTurn` does the same at
`src/supervisor/threads/store.ts:182-212`. Their public coordinator surface also requires it at
`src/supervisor/projects/turn-settle.ts:7-16`, and every production caller carries the admitted id
at `src/supervisor/projects/turn-run.ts:143-156` and
`src/supervisor/projects/turn-settle.ts:54-83,116-124`. `startFreshThread` writes without an
admitting lease at `src/supervisor/threads/store.ts:61-87`, but it is the explicit replacement
operation: it increments the revision and clears the old lease, rather than finishing or abandoning
a turn.

This verdict is narrow. A timed-out orphan can still write workspace files without a valid thread
lease, as finding 1 explains. T5 fenced durable conversation completion, not tool effects.

## 4. The diff guarantee

**Verdict: holds for ordinary tracked edits and typed tool/model failures; degrades honestly without
git; fails for untracked files, cancellation, and unexpected throws.**

The mutating flag is set on tool start, before a tool result can fail, at
`src/facet/generation-0/facet-turn.ts:43-57`. A typed failed outcome still returns and therefore gets
the diff before the failed terminal frame at `src/facet/generation-0/facet-turn.ts:60-69` and
`src/facet/generation-0/pi-agent-turn.ts:162-168`. There is no direct failed-mutating-tool regression
test. If `runPiAgentTurn` throws unexpectedly, control jumps to `controller.error` and no diff is
published at `src/facet/generation-0/facet-turn.ts:119-124`. Cancellation intentionally suppresses
the diff at `src/facet/generation-0/facet-turn.ts:66,98-103,128-132`.

Without git, nonzero exit becomes `diff-unavailable` at
`src/facet/generation-0/workspace-diff.ts:65-84`; the focused test proves that explicit frame at
`test/facet/generation-0/turn-diff.test.ts:166-185`. This is honest degradation, not a literal diff
guarantee. Real Computer/git remains unverified because Q7 blocks it.

A new unstaged file is invisible because the fixed command is `git --no-pager diff HEAD` at
`src/facet/generation-0/turn-policy.ts:39-55`. Worse, the fake computes diffs for current-only paths,
so `test/supervisor/projects/project-turn.test.ts:74-94` can claim a newly written `notes.txt` is in
the diff although production git would omit it. The production command is also repository-vs-HEAD,
not a per-turn baseline: it includes earlier dirty changes and can show nothing if the turn commits.
Either include untracked files and define a true turn baseline, or narrow ADR-0040 and correct the
fake so tests match production.

Finally, the guarantee does not reach the user at this commit because the page drops both diff
frames (finding 2).

## 5. Cut lines

**Verdict: some necessary crossings were sound, but two cut decisions left an unshippable merge.**

- **Necessary crossing, keep it.** T9b changed the facet handoff outside its listed scope. The host
  now sends `{prompt, messages}` at `src/supervisor/projects/turn-run.ts:34-42`, while the generation
  constructs its model and system prompt at `src/facet/generation-0/facet-turn.ts:46-52`. Reverting
  this would put generation policy in the host or trust client-supplied state.
- **Temporary cut resolved.** T3a left legacy `WorkspaceHost.execute` for T7/T9. It no longer exists
  in `src`, so that staged cut did not survive the merge.
- **T13/T10 integration cut did not hold.** T13 added two protocol variants after T10 was already
  built against the old vocabulary. T10's copied “exhaustive” list and renderer omit them
  (`test/page/owner-page.test.ts:78-96`; `src/page/script-turn.ts:86-109`). The result cannot meet
  criterion 4.
- **T10 was merged before its own acceptance work existed.** Its report says the browser harness was
  in progress, yet `package.json:21` and `AGENTS.md:23-25` were committed without the implementation.
  This is not a prudent cut; it is a broken public command and missing evidence.
- **T13's untracked-file cut contradicts its broad claim.** The command explicitly omits new
  unstaged files at `src/facet/generation-0/turn-policy.ts:49-54`, while the fake covers them. It is
  enough for the narrow demo that edits an existing file, but not for “the turn's diff”.
- **T10's no-build-step cut leaves its “checked TypeScript” acceptance unmet.** The delivered client
  remains generated JavaScript text; its only supposed exhaustiveness check already missed both T13
  variants. That is concrete evidence the substitute is insufficient.

## 6. The four goal criteria not wholly blocked on Q7

### Criterion 1 — **not met**

The exact commit passes `pnpm verify`, and the manifest exposes the build/deploy-related commands at
`package.json:13-22`. There are no release notes naming `7818f8d`, the pinned Computer pair, the
model route, and reproducible deployment commands. A green development commit is only half this
criterion.

### Criterion 4 — **not met locally, before the paid real-turn proof**

The project sidebar exists at `src/page/markup-sidebar.ts:16-48`, and the client reads NDJSON with a
stream reader at `src/page/script-turn.ts:129-155,184-205`. The facet deterministically produces a
tracked-file diff at `src/facet/generation-0/facet-turn.ts:62-69`. But the page drops it at
`src/page/script-turn.ts:86-109`, and the promised browser harness is absent. The real model,
Computer, and check run also remain unverified under Q7.

### Criterion 5 — **implemented in parts, not proved end to end**

One active turn is enforced at `src/supervisor/threads/decisions.ts:20-57`; repository and managed
instructions are loaded at `src/facet/generation-0/instructions.ts:51-79`; compaction occurs before a
turn at `src/facet/generation-0/pi-agent-turn.ts:101-125`; fresh thread resets only durable
conversation state at `src/supervisor/threads/store.ts:61-87`. But the named replacement test passes
`compacted.state` directly into another in-process facet at
`test/facet/generation-0/compaction.test.ts:111-143`. It never commits through the Supervisor,
reloads the saved thread, and crosses a replacement generation. Add that integration proof before
calling the criterion met.

### Criterion 6 — **local logic mostly met; the whole criterion is not met**

Completed-real-turn credit follows a successful lease-fenced save at
`src/supervisor/projects/turn-settle.ts:78-108`; rejected, invalid, cancelled, and timed-out endings
release without credit at `src/supervisor/projects/turn-settle.ts:133-170`; stale finish and abandon
are rejected at `src/supervisor/threads/decisions.ts:64-106`. However, the deadline implementation
can outlive its lease and orphan work (finding 1), and the criterion's required paid disconnect and
deadline evidence remains blocked on Q7. Local credit behavior is strong; the full criterion is not
closed.

## Unverified items

All platform-dependent facts remain unverified: real Workers AI fragment streaming, `gh` and `tar`
in the pinned Computer image, real git diff behavior through Computer, build/cache behavior, Access
across two browsers, disconnect propagation, restart/eviction, concurrency, credential persistence,
and R2 lifecycle. The named paid probes would settle them; Q7 forbids running them now.

**NOT SOUND — make turn lifetime one lease-scoped, absolute-deadline operation with cancellation propagated through start and streaming.**
