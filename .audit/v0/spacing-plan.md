# Plan: require readable spacing without line-count theater

> Draft for argument with the Opus orchestrator. Do not execute until the "Agreement" section says
> both agents signed the same revision.

## Status and scope

- Planned against commit `541a484cbf86a0d7ebae601ea0c2b1219aba1e10` on
  `work/readable-spacing`.
- This plan changes lint policy, one existing lint-exception comment, one ADR, and whitespace. It
  does not change runtime behavior.
- The execution owner works only in `/home/aditya/wt/spacing`. No unit may read from or write to
  `/home/aditya/repos/cf-stumble`, update its branches, run a deployment, or touch the deployed
  Worker.
- Every mutating unit ends in one commit. Do not squash the commits. The whitespace commit must
  contain only inserted blank lines.

## Recommendation

Enable `anti-slop/require-readable-spacing`, but do not split the 15 files or 12 functions that
cross the current physical-line ceilings after its fix. Configure `eslint/max-lines` and
`eslint/max-lines-per-function` with `skipBlankLines: true` and `skipComments: false`. Keep their
existing limits of 300 and 50.

A size ceiling should limit source content. The spacing rule requires blank lines between logical
statement groups. If the size rules count those required lines, the rules disagree about the same
text and force new modules that hide no complexity. With blank lines excluded, every one of the 27
reported files or functions is inside the existing content budget. Comments still count because a
reader must understand them.

This is not a blanket file exemption. It exempts only blank lines from the two counters. It adds no
new file-level or function-level suppression. Eight existing size suppressions remain after a
remove-and-lint audit: three file-level `max-lines` suppressions and five test-function
`max-lines-per-function` suppressions. Unit 3 adds the missing reason to the only bare suppression
and deletes one pre-existing stale directive.

## Evidence

Two Sonnet measurement agents, the planner, and the Opus orchestrator reproduced the result in
separate `/tmp` copies. The source worktree stayed unchanged.

| Measurement at `541a484` | Result |
| --- | ---: |
| Oxlint files scanned | 329 |
| Readable-spacing diagnostics | 2,325 |
| Files with a readable-spacing diagnostic | 261 |
| Autofix changes | 2,325 inserted blank lines, 0 deletions |
| Post-fix `max-lines` diagnostics | 15 |
| Post-fix `max-lines-per-function` diagnostics | 12 |
| Distinct paths carrying those 27 diagnostics | 23 |
| Diagnostics after both size rules set `skipBlankLines: true` | 0 |

The 2,322 count in `oxlint.config.ts` came from commit `1b2952b`. Later access and artifact changes
added three sites without adding another affected file. The config also says "27 files". The
accurate statement is 27 diagnostics across 23 paths.

Use this reproduction order in a disposable copy when the base commit changes:

1. Run `pnpm build:pi`. Type-aware lint needs the generated Pi declarations.
2. Run `pnpm verify` and require a clean baseline.
3. Change only `"anti-slop/require-readable-spacing": "off"` to `"error"` in the copy.
4. Run `./node_modules/.bin/oxlint --type-aware --format=json` and count diagnostics.
5. Run `./node_modules/.bin/oxlint --fix` without `--type-aware`.
6. Run `pnpm format`, then `pnpm lint` in a fresh process.

Do not judge the fixed tree from a type-aware `--fix` invocation's own diagnostics. Oxlint 1.80.0
reported five transient type-aware findings at correctly suppressed lines during that mutation
pass. A fresh lint pass reported none. The non-type-aware and type-aware fixes produced byte-for-byte
identical source trees in an independent comparison. The execution below therefore uses the quieter
non-type-aware fix, then uses the normal type-aware lint as proof.

`oxfmt` made no further source change in three isolated trials. `pnpm verify` rebuilt all four
module-map fixtures from the spaced source and then passed 110 test files and 780 tests in the
orchestrator's scratch copy. A bare lint run is not enough because those ignored fixtures embed the
changed source text.

## Disposition of the 15 file diagnostics

"Counted" means lines after the fix with blank lines skipped and comments retained. Every value is
below 300. The proposed split seam is therefore "none" unless maintenance evidence independent of
this lint change later justifies one.

| File | Before physical | After physical | Added blanks | Counted | Decision and reason |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/access/verification.ts` | 299 | 331 | 32 | 270 | Do not split. One trust-boundary module decodes, verifies, and checks one Access token. Splitting the pipeline would expose partially proved JWT state. |
| `src/facet/generation-0/execution-env-exec.ts` | 265 | 303 | 38 | 242 | Do not split. One `Shell.exec` adapter owns command admission and its NDJSON event lifecycle. The small interface hides stream state and typed failures. |
| `src/facet/generation-0/route-stream.ts` | 266 | 309 | 43 | 251 | Do not split. One adapter translates the model route stream into Pi events. Existing `workers-ai-adapter.ts` and `stream-assembler.ts` already hold the useful pure seams. |
| `src/model-route-stream.ts` | 292 | 330 | 38 | 270 | Do not split. One provider-stream adapter turns Workers AI SSE into the route's closed event protocol. Its parser is already separated in `model-route-stream-parse.ts`. |
| `src/model-route.ts` | 300 | 355 | 55 | 267 | Do not split. One Worker entrypoint owns the closed request contract, validation, fixed provider policy, and buffered compatibility path. At 267 counted lines it remains under budget. |
| `src/supervisor/projects/github-connection.ts` | 298 | 321 | 23 | 274 | Do not split. One stateful GitHub connection module owns device authorization, credential installation, observation, and recorded status. Splitting would leak token/state transitions. |
| `src/workspace/project/target.ts` | 298 | 341 | 43 | 269 | Do not split. One six-method `ProjectRpcTarget` adapter is the deliberately narrow project capability. Splitting its implementation would turn the RPC class into a pass-through. |
| `test/facet/generation-0/adapter.test.ts` | 300 | 320 | 20 | 273 | Do not split. One contract suite covers both directions of the Workers AI adapter and one complete tool-call cycle. A split would duplicate fixtures or hide the round trip. |
| `test/model-route.test.ts` | 291 | 305 | 14 | 272 | Do not split. One suite specifies the buffered model-route request, provider payload, validation, response, and redaction contract; streaming already has its own suite. |
| `test/routes/generation-submission.test.ts` | 292 | 303 | 11 | 264 | Do not split. One route suite covers the full generation-submission outcome table and shares one recording supervisor. |
| `test/supervisor/artifacts/build-workspace.test.ts` | 297 | 312 | 15 | 257 | Do not split. One adapter suite covers the build workspace plan, provisioning, phase failure, and path refusal through shared fakes. |
| `test/supervisor/artifacts/module-map-store.test.ts` | 289 | 303 | 14 | 257 | Do not split. One persistence suite covers chunking, atomic failure, eviction, corruption, and rollback through the same store interface. |
| `test/supervisor/control/control.test.ts` | 300 | 312 | 12 | 257 | Do not split. One generation-control suite covers the command/state transition table and shared generation setup. |
| `test/supervisor/threads/threads.test.ts` | 291 | 303 | 12 | 251 | Do not split. One project-thread lifecycle suite covers admission, revision, concurrency, persistence, takeover, and deadline settlement. |
| `test/workspace/project/fakes.ts` | 281 | 320 | 39 | 250 | Do not split. The filesystem, transaction, and exec fakes form the backing adapter family constructed together by project-capability tests. At 250 counted lines, another import seam buys little. |

## Disposition of the 12 function diagnostics

Every function remains at or below 48 counted lines. No function-level suppression is needed.

| File | Function | After physical | Counted | Decision and reason |
| --- | --- | ---: | ---: | --- |
| `src/facet/generation-0/execution-env-exec.ts` | `execViaProjectTarget` | 51 | 40 | Do not split or suppress. One command-admission sequence validates options and path, starts RPC execution, proves the envelope, then hands the live stream to its consumer. |
| `src/facet/generation-0/execution-env-exec.ts` | `readNextEvent` | 56 | 44 | Do not split or suppress. One event transition handles EOF, malformed input, channel output, cancellation, and terminal events while keeping kill behavior adjacent. |
| `src/facet/generation-0/facet-turn.ts` | `startFacetTurn` | 56 | 47 | Do not split or suppress. One `ReadableStream` lifecycle keeps request parsing, capability leasing, completion, cancellation, and release on the same mutable lease. |
| `src/facet/generation-0/route-stream.ts` | `pumpModelStream` | 61 | 48 | Do not split or suppress. One reader loop owns cancellation, incremental NDJSON decoding, event application, terminal detection, and cleanup. |
| `src/routes/owner-api.ts` | `routeOwnerApiRequest` | 53 | 40 | Do not split or suppress. One ordered route table preserves precedence across project, turn, status, generation, and thread routes. |
| `src/supervisor/projects/github-connection.ts` | `completeAuthorization` | 56 | 45 | Do not split or suppress. One device-flow transition validates the initiating owner, redeems once, clears terminal state, and installs an authorized token without exposing it. |
| `src/supervisor/projects/project-turn.ts` | `streamProjectTurn` | 57 | 44 | Do not split or suppress. One deliberately ordered sequence resolves selection, mounts, provisions, obtains the capability, and starts the turn with abort checks between calls. |
| `src/supervisor/startup-check/body.ts` | `drainBody` | 51 | 43 | Do not split or suppress. One bounded stream loop races reads against the deadline, counts bytes, cancels on limits, and releases the reader lock. |
| `src/workspace/project/resolve.ts` | `resolveAddressedPath` | 51 | 39 | Do not split or suppress. One symlink-aware path-walk state machine owns queue, current path, link count, root checks, and terminal outcome. |
| `test/facet/generation-0/pi-agent-turn.test.ts` | `anonymous test callback` | 54 | 48 | Do not split or suppress. One end-to-end test proves that the same Pi turn reaches all four stock tools; splitting it would weaken that combined claim. |
| `tools/browser-harness/browser-errors.mts` | `collectBrowserErrors` | 54 | 45 | Do not split or suppress. One registration function folds all three browser fault channels into one accessor. Private formatter helpers would not create a test seam unless exported. |
| `tools/vendor-pi.mts` | `checkVendorTree` | 54 | 42 | Do not split or suppress. One ordered integrity gate checks templates, manifest coverage and hashes, pin, license, and built imports. The new blank lines already name its phases visually. |

The exploration agents proposed real names, not only vague "split this file" advice. The planner
still rejects them for this rollout after applying the deletion test and checking caller patterns:

| Proposed seam | Why it loses here |
| --- | --- |
| Move untrusted JWT decoding from `access/verification.ts` to `access/jwt-token.ts` | The new interface would expose a partially proved header and claims between parsing and signature policy. Keeping the security-sensitive order inside one verification module has better locality. |
| Move request validation from `model-route.ts` to `model-route-validate.ts` and split its test suite | The route's closed contract, validation, fixed provider policy, and entrypoint are 267 counted lines together. A re-export and type-import cycle would make readers cross another file without hiding provider complexity. Revisit when the deprecated buffered path is deleted. |
| Move byte framing from `model-route-stream.ts`, or Pi context conversion from `route-stream.ts`, into one-caller modules | Both stream adapters already delegate parsing and assembly at useful seams. The proposed modules would have one caller and interfaces almost as large as their implementations. |
| Add `threads.ts` and another generation router beneath `routeOwnerApiRequest` | The current router is a 40-counted-line precedence table. Two more delegation modules would hide that order rather than simplify it. |
| Split the oversized test suites by command or behavior | Each suite is at most 273 counted lines and shares setup for one interface. The proposed partitions duplicate fixtures or make one contract require several files. A misplaced rollback test can move in a separate test-locality change if maintainers want it. |
| Split `test/workspace/project/fakes.ts` into provider and exec files | Every direct consumer constructs the filesystem, transaction, and exec fakes together. Two import paths would expose a distinction callers do not use. |
| Extract phase or formatter helpers in the two tool functions and the stream loops | Most helpers would have one call site. Private browser formatters do not create a test seam, and exporting them would enlarge the interface. Required blank lines already make the phases visible. |
| Extract repeated abort or abnormal-frame branches | The proposed helpers save a few lines but pass the same mutable stream state through more parameters. They do not make the adapter deeper. |
| Add `ProjectExecOperations`, `decideRecordedStatus`, or `decideBodyProgress` | These were the strongest independent proposals and match ADR-0036's vocabulary. They still change internal design without a current behavior fault, and the existing tests already exercise the real interfaces. Review them as a separate pure-decision/imperative-shell change, not as a condition for accepting blank lines. |

These can become separate architecture proposals if future churn supplies stronger evidence. This
lint rollout does not smuggle them into a whitespace policy.

## Existing size exceptions after the rollout

Every size directive in the tree was audited by deleting it, one at a time, and running the full
type-aware lint gate. Nine exist at `541a484`. Eight are load-bearing and one is stale. Do not use
`--report-unused-disable-directives` for this audit: in Oxlint 1.80.0 it did not report the stale
file-level directive. The effective check is removal followed by the gate.

Three files exceed 300 counted lines even with blank lines skipped. They are outside the 27 new
diagnostics because they already carry suppressions.

| File | Oxlint count after spacing | Decision |
| --- | ---: | --- |
| `tools/vendor-pi.mts` | 752 | Keep its existing reason. The updater owns generated declaration templates and copied-file checks together. |
| `src/supervisor/supervisor.ts` | 307 | Keep its existing reason. One Durable Object class is the runtime's RPC interface and delegates work to deeper modules. |
| `src/workspace/project/exec-operation.ts` | 332 | Keep the exception, but Unit 3 must add a reason. One stream state machine owns framing, settlement, timeout, cancellation, and the single-terminal-event invariant. |

Five test functions exceed 50 counted lines and retain their existing suppressions.

| File | Oxlint function count after spacing | Decision |
| --- | ---: | --- |
| `test/access-cookie.test.ts` | 143 | Keep. One Access-cookie integration function shares the same Worker and cookie flow. |
| `test/access.test.ts` | 91 | Keep. One Access verification integration function shares its trust-boundary setup. |
| `test/access-owner.test.ts` | 77 | Keep. One owner-access integration function shares identity and route setup. |
| `test/github/credential-surfaces.test.ts` | 53 | Keep for now. It is three lines over the content ceiling; delete and re-audit the directive after the next simplification. |
| `test/facet/generation-0/execution-env-loaded.test.ts` | 51 | Keep for now. It is one line over the content ceiling; delete and re-audit the directive after the next simplification. |

The ninth directive, in `src/supervisor/projects/turn-run.ts`, was already stale at `541a484`: the
unchanged file has 225 physical lines, and deleting only that line leaves the baseline gate green.
Unit 3 removes it because that unit already owns size-exception hygiene. The 28 directives reported
by `--report-unused-disable-directives` are identical before and after the full spacing change, so
this branch creates no newly stale directive, but that flag does not establish file-level hygiene.

## Execution graph

| Unit | Commit | Owned files | Depends on | Scheduling |
| --- | --- | --- | --- | --- |
| 1. Record the decision | `docs(adr): let size ceilings measure content` | `docs/agents/adr/0041-line-ceilings-measure-content.md`, `docs/agents/adr/README.md` | none | first |
| 2. Make the size rules count content | `lint: exclude blank lines from size ceilings` | `oxlint.config.ts` | Unit 1 | strictly after Unit 1 |
| 3. Reconcile existing size exceptions | `lint: reconcile size exceptions` | `src/workspace/project/exec-operation.ts`, `src/supervisor/projects/turn-run.ts` | none logically; ordered after Unit 2 for one linear branch | strictly after Unit 2 |
| 4. Insert the required spacing | `style: insert readable spacing` | lint-selected `src/**/*.ts`, `test/**/*.ts`, and `tools/**/*.mts`; no ignored or other path | Units 2 and 3 | strictly after Unit 3 |
| 5. Enforce readable spacing | `lint: require readable spacing` | `oxlint.config.ts` | Unit 4 | strictly after Unit 4 |

Units 1 and 3 are logically independent and own disjoint files, but this plan does not run them in
parallel. All five units form one verified commit series, which removes cherry-pick coordination
while `main` is moving. Unit 2 and Unit 5 both own `oxlint.config.ts`, so they are strictly ordered.
Unit 4 owns the global mechanical paths and therefore cannot overlap any other unit. No two units
may run in parallel. Do not parallelize full verification in one worktree because the build
commands write ignored fixtures.

## Release coordination before Unit 1

Execute the five units now on `work/readable-spacing` at `541a484`. Run `pnpm verify` before Unit 1,
keep every commit in `/home/aditya/wt/spacing`, and do not merge into `main`. The release checkout,
its branches, and the deployed Worker remain untouched. A moving `main` cannot break this isolated
branch, and waiting for the release would be an unbounded precondition.

After all five units pass, give release agent `23bcb880af71` the branch name and five commit hashes
as a handoff. State that Unit 4 is generated and must not be conflict-resolved. Do not ask the
release agent to merge while its release work is active.

When `main` stops moving, integrate without rebasing the whitespace commit:

1. Start a fresh integration branch at final `main`.
2. Cherry-pick Units 1, 2, and 3 only. These are the small judgment commits.
3. Regenerate Unit 4 from the final tree. Never rebase or resolve conflicts in the old 261-file
   whitespace commit.
4. Recreate Unit 5 on top of the regenerated spacing.
5. Run `pnpm verify` again.

If any small cherry-pick conflicts, stop and report the release change. Do not guess. If final
`main` changes the counts but its baseline and the post-fix checks stay green, record the new counts
in the integration report. A changed count does not justify hand-merging generated whitespace.

## Unit 1: record the content-budget decision

### Files owned

- Create `docs/agents/adr/0041-line-ceilings-measure-content.md`.
- Edit `docs/agents/adr/README.md` only to add ADR-0041 under agent-only decisions.

### Change and reason

Write this ADR exactly, subject only to `pnpm format` changes:

```markdown
# Let size ceilings measure content and spacing own grouping

> **Review:** Agent-only

`anti-slop/require-readable-spacing` requires blank lines between declarations and logical
statement groups. Configure `eslint/max-lines` and `eslint/max-lines-per-function` to skip blank
lines while keeping their limits at 300 and 50. Keep comments in both budgets.

Against commit `541a484`, the spacing fix inserted 2,325 blank lines in 261 files. Counting those
required lines produced 15 file diagnostics and 12 function diagnostics across 23 paths, although
none gained executable code, types, tests, or comments. With blank lines skipped, the affected
files contain 242 to 274 counted lines and the affected functions contain 39 to 48. All remain
inside the existing limits.

Six independent readers reviewed all 2,325 insertions. They objected to 78, or 3.4 percent. Every
objection was a compact guard chain, a one-call-and-return switch case, or top-level constants that
a comment already groups. No reader found a comment separated from its subject, a split data
literal, or a general reason to reject the change. The rule has no options (`schema: []`), so a
softer layout would require a local fork of the verbatim vendored plugin.

The project accepts that measured local cost and adds no spacing suppression. A required disable
comment with a reason would be louder than the blank line it removed, repeated suppressions would
cost more lines than they save, and a local plugin fork would cost more to maintain than the 3.4
percent. Splitting the modules would add interfaces, imports, or test setup without hiding
complexity. The size rules therefore measure content, while the spacing rule owns vertical
grouping. This does not skip comments: prose is content a reader must understand.

The tightest repository-wide values that pass this snapshot are 275 and 48. This change does not
adopt them. Tightening the budgets is a separate decision, and 275/48 would leave the largest file
and function almost no headroom during a release.

A physical file may now exceed 300 lines because of required spacing. Split a module only when
its content crosses the budget or an architectural review finds a real seam with better
locality or a deeper interface.

Every size directive in the tree was audited by deleting it and running the gate. Nine exist,
eight of them load-bearing. Three file-level `max-lines` exceptions remain, on
`tools/vendor-pi.mts` at 752 counted lines, `src/supervisor/supervisor.ts` at 307, and
`src/workspace/project/exec-operation.ts` at 332. Five `max-lines-per-function` exceptions
remain on test functions, in `test/access-cookie.test.ts` at 143, `test/access.test.ts` at 91,
`test/access-owner.test.ts` at 77, `test/github/credential-surfaces.test.ts` at 53, and
`test/facet/generation-0/execution-env-loaded.test.ts` at 51. The ninth, on
`src/supervisor/projects/turn-run.ts`, suppressed nothing at `541a484` and is deleted here.
```

Add this index entry as the last bullet under `## Agent-only decisions`, immediately after the
ADR-0040 bullet and before `## Adding a decision`:

```markdown
- **[ADR-0041](0041-line-ceilings-measure-content.md)**: size ceilings count code and comments,
  while required blank lines do not consume their budgets.
```

`oxfmt` formats Markdown. The new ADR increases its scanned-file count from 376 to 377, so both the
entry placement and surrounding blank lines must pass the normal format check.

### Verification

Run:

```sh
pnpm test test/docs/adr-index.test.ts
pnpm verify
git diff --check
```

Expected result: both commands exit 0, the ADR index test passes, and only the two owned paths have
tracked changes.

### Done and failure handling

Commit only the two owned paths with the stated message. Done means the ADR declares the decision,
alternative, measurements, and consequences, and the index names it. If the index test reports a
different next ADR number or the relevant docs changed since `541a484`, stop and report the drift.
Do not renumber or rewrite another ADR without review.

## Unit 2: make both size rules count content

### File owned

- `oxlint.config.ts`

### Change and reason

Insert these entries immediately after the existing
`"typescript/prefer-readonly-parameter-types": "off",` entry and before the existing
`"eslint/no-console": "off",` entry. Use this exact comment and options:

```ts
    // `anti-slop/require-readable-spacing` mandates blank lines. At 541a484, turning it on
    // pushed 15 files and 12 functions over their physical-line limits without adding content; all
    // 23 affected paths stay within these budgets when blank lines do not count. Splitting them
    // would add interfaces and imports without hiding complexity. The measured 275/48 alternative
    // would reproduce the snapshot's tightest content budget, but changing the maxima is a separate
    // decision and would leave almost no headroom. `skipComments` stays false because comments are
    // content a reader must understand. See ADR-0041.
    "eslint/max-lines": ["warn", { max: 300, skipBlankLines: true, skipComments: false }],
    "eslint/max-lines-per-function": [
      "warn",
      { max: 50, skipBlankLines: true, skipComments: false },
    ],
```

Do not change either numeric maximum. Do not set `skipComments: true`. Write the explicit
`skipComments: false`; Oxlint omits that property from `--print-config` when the config omits it, and
the verification intentionally proves that comments stay in the budget. Leave
`anti-slop/require-readable-spacing` off in this unit.

### Verification

Run:

```sh
pnpm verify
./node_modules/.bin/oxlint --print-config > /tmp/readable-spacing-print-config.json
node -e 'const c=require("/tmp/readable-spacing-print-config.json"); for (const [r,m] of [["max-lines",300],["max-lines-per-function",50]]) { const o=c.rules[r]?.[1]?.[0]; if (o?.max!==m || o?.skipBlankLines!==true || o?.skipComments!==false) process.exit(1); }'
git diff --check
```

Expected result: `pnpm verify` exits 0, the printed config check exits 0, and only
`oxlint.config.ts` changed.

### Done and failure handling

Commit the owned file with the stated message. If another diagnostic appears, restore this unit's
change and report the rule, path, and output. Do not raise a maximum, add a path suppression, or
split production code in this unit.

## Unit 3: reconcile the existing size exceptions

### Files owned

- `src/workspace/project/exec-operation.ts`
- `src/supervisor/projects/turn-run.ts`

### Change and reason

Replace the bare first line with this exact comment:

```ts
// oxlint-disable max-lines -- One exec operation owns framing, backend settlement, timeout,
// cancellation, and one terminal event as one stream state machine. Splitting those transitions
// would expose mutable settlement state and weaken the single-terminal-event invariant.
```

In `src/supervisor/projects/turn-run.ts`, delete only this directive:

```ts
// oxlint-disable max-lines, max-lines-per-function -- Admission is one ordered sequence: prompt, read, revision, lease, bound, attribution. Splitting it would hide the order that makes the turn the server's, so the sequence stays whole and this file carries it.
```

Keep the preceding anti-slop boundary directive. This size directive is already stale at
`541a484`, before Unit 2: the file has 225 physical lines, and deleting only the directive leaves
baseline type-aware lint at zero warnings and errors. After spacing, it has 202 counted lines and
its largest function, `runProjectTurn`, has 41.

Do not change either implementation. Oxlint reports `exec-operation.ts` at 332 counted lines after
this comment change and the spacing fix. This unit records why that module stays whole and removes
the one pre-existing size exception that suppresses nothing.

### Verification

Run:

```sh
pnpm verify
rg -n '^// oxlint-disable max-lines -- ' src/workspace/project/exec-operation.ts
! rg -n 'oxlint-disable max-lines(?:, max-lines-per-function)?' src/supervisor/projects/turn-run.ts
git diff --check
```

Expected result: verify exits 0, the first `rg` prints line 1 once, the negative `rg` finds no size
directive in `turn-run.ts`, and only the two owned comments changed.

### Done and failure handling

Commit only the two owned files with the stated message. If either implementation changed, discard
that change. If verification fails outside these comments, compare with the clean baseline and
report it. Do not retain a stale size directive or use the surviving exception to suppress another
rule.

## Unit 4: insert readable spacing as a mechanical commit

### Files owned

This unit owns only files selected and changed by the spacing fix under these globs:

- `src/**/*.ts`
- `test/**/*.ts`
- `tools/**/*.mts`

At `541a484`, that is exactly 98 files under `src`, 119 under `test`, and 44 under `tools`, for 261
files. It owns no file under `tools/oxlint/anti-slop`, `vendor`, `containers`, `.audit`, or any build
output. It may traverse other linted TypeScript files but must not change them. The 261-file,
2,325-addition, zero-deletion result was re-measured after Units 1 through 3 were applied together,
not only on the bare base commit.

### Change and reason

Start from a clean integrated tree containing Units 1 through 3. Temporarily change the spacing
rule from `off` to `error`, run its fix, prove the fixed tree with the rule live, then restore
`oxlint.config.ts` before committing. Use this order:

```sh
pnpm verify
# Edit only the one require-readable-spacing value from "off" to "error".
./node_modules/.bin/oxlint --fix
./node_modules/.bin/oxlint --fix
pnpm format
pnpm build:pi
pnpm lint
git restore --source=HEAD -- oxlint.config.ts
```

Both fix passes must print `Found 0 warnings and 0 errors` because Unit 2 already excludes blank
lines from the size counts. The first pass inserts the blanks. The second changes no file and proves
a fixpoint. In the earlier reproduction without Unit 2, a fresh post-fix lint instead reported the
27 size warnings; the different output is expected in that different context. Use the
non-type-aware fix command to avoid Oxlint 1.80.0's transient type-aware diagnostics. `pnpm lint` is
the fresh type-aware proof. Do not hand-edit any fixed source line.

### Verification and mechanical proof

Before the commit, run:

```sh
pnpm verify
test "$(git diff --name-only | wc -l)" -eq 261
test "$(git diff --numstat | awk '{ added += $1 } END { print added + 0 }')" -eq 2325
test "$(git diff --numstat | awk '{ deleted += $2 } END { print deleted + 0 }')" -eq 0
git diff --ignore-blank-lines --exit-code
git diff --check
git diff --exit-code -- oxlint.config.ts tools/oxlint/anti-slop vendor containers
node -e 'const {execFileSync}=require("node:child_process"); const {readFileSync}=require("node:fs"); const files=execFileSync("git",["ls-files","src","test","tools","containers"],{encoding:"utf8"}).trim().split("\n").filter(f=>/\.(?:ts|mts)$/u.test(f)&&!f.startsWith("tools/oxlint/anti-slop/")); let count=0; const broken=[]; for(const f of files){const ls=readFileSync(f,"utf8").split(/\r?\n/u); for(let i=0;i<ls.length;i+=1){if(!ls[i].includes("oxlint-disable-next-line"))continue; count+=1; if((ls[i+1]??"").trim()==="")broken.push(`${f}:${i+1}`);}} if(count!==229||broken.length){console.error(JSON.stringify({count,broken}));process.exit(1)} console.log(`checked ${count} disable-next-line comments`)'
```

Expected result at the planned commit:

- `pnpm verify` exits 0 after rebuilding the module-map and loaded-execution fixtures.
- The diff has 261 files, 2,325 additions, and zero deletions.
- Ignoring blank-line-only hunks leaves an empty diff.
- `oxlint.config.ts` and every excluded path are unchanged.
- All 229 `oxlint-disable-next-line` comments still have a non-blank physical next line.

After committing with the stated message, repeat the diff proofs against `HEAD^` and `HEAD`:

```sh
git diff --ignore-blank-lines --exit-code HEAD^ HEAD
test "$(git diff --numstat HEAD^ HEAD | awk '{ deleted += $2 } END { print deleted + 0 }')" -eq 0
```

### Done and failure handling

Done means the commit contains only inserted blank lines and the full gate passes against rebuilt
fixtures. If the base is still `541a484` and either count differs, restore the unit to its start
commit and report the exact diff. If this is a documented regeneration on a newer final `main`,
record the new counts, require zero deletions and an empty `--ignore-blank-lines` diff, and continue
only if `pnpm verify` is green. If any suppression check fails, restore and report the named line.
Do not repair generated spacing by hand or add rule suppressions.

## Unit 5: enforce the spacing rule

### File owned

- `oxlint.config.ts`

### Change and reason

Delete the current "Off, with the count from the re-vendor run" block, including its stale 2,322
and "27 files" claims. Immediately after the existing
`"anti-slop/no-widen-then-assert": "error",` entry and before the existing
`"anti-slop/require-safety-comment-for-type-assertion": "error",` entry, insert only this comment
and rule entry:

```ts
    // At 541a484, all 2,325 sites across 261 files were fixed by inserting blank lines only. Six
    // independent readers reviewed every insertion and objected to 78, or 3.4 percent, all in
    // compact groups that the rule spread out. None is suppressed: the rule has no options, the
    // vendored plugin stays verbatim, and a disable comment with a reason is louder than the blank
    // line it would remove. ADR-0041 records the measured cost and decision.
    "anti-slop/require-readable-spacing": "error",
```

The two named neighboring entries are anchors, not text to duplicate.

Do not change the options from Unit 2. Do not add a spacing suppression.

### Verification

Run:

```sh
pnpm verify
rg -n '^    "anti-slop/require-readable-spacing": "error",$' oxlint.config.ts
test "$(rg -c '^    "anti-slop/require-readable-spacing": "error",$' oxlint.config.ts)" -eq 1
! rg -n '^    "anti-slop/require-readable-spacing": "off",$' oxlint.config.ts
git diff --check
```

Expected result: full verify exits 0, the rule appears once at `error`, no stale count remains, and
only `oxlint.config.ts` changed.

### Done and failure handling

Commit the owned file with the stated message. If lint reports a spacing site, do not add an
exception or mix another fix into this commit. Revert the config edit, report the path, and return
to Unit 4 in a fresh mechanical commit.

## Completed readability review and browser scope

Before this plan was signed, six independent readers reviewed disjoint path partitions covering all
261 files and all 2,325 insertions. They raised 78 objections, or 3.4 percent. Forty-nine were blank
lines inside compact one-line guard groups, 28 were between grouped declarations or deliberately
paired fixtures, and one was inside a compact switch pattern. The other 2,247 insertions drew no
objection. No review found a comment separated from its subject, a split data literal, a broken
overload or
assertion unit, or a general reason to reject adoption.

The plan deliberately adds no spacing suppression for the 78 objections. The rule has no options
and the vendored copy stays verbatim. A `disable-next-line` comment with a written reason is louder
than one blank line, and many guard chains would need several comments. Adding roughly 90 to 120
suppression lines to remove about 78 quiet lines would make the local problem worse. The ADR records
this cost once. Unit 4 still runs the mechanical suppression-binding check because a future rebase
can change the generated diff.

`pnpm harness:browser` is not required. Units 1, 2, 3, and 5 change prose or lint configuration.
Unit 4 changes no token and `pnpm verify` rebuilds and runs the real module-map fixtures. If any unit
changes a JavaScript token or browser behavior, this premise is false: stop and run the browser
harness under `tools/browser-harness/README.md` before continuing.

## Rollback

Keep all five commits. Do not squash them.

- Revert Unit 5 alone to turn enforcement off while keeping harmless spacing.
- Revert Unit 3 alone to restore the old bare exception comment and the now-stale `turn-run.ts`
  size directive, although doing so loses the recorded reason and clean exception set.
- Revert Units 5 then 4 to remove the generated whitespace without leaving the live rule failing.
- Revert Units 5 and 4 before reverting Unit 2, because the spaced tree needs blank-line skipping to
  satisfy the content ceilings.
- Revert Unit 1 when Unit 2 is reverted so the current ADR does not describe an abandoned policy.

Each unit is a separate commit with a mechanical inverse. Dependencies require reverse-order
rollback, but no rollback requires a hand edit or a mixed revert. After any rollback sequence, run
`pnpm verify`.

## Argument record

### Round 1: split 27 reported items or change what the ceilings count

The planner began by looking for extraction seams in `model-route.ts`, the stream adapters, Access
verification, the project target, test suites, and the two tool functions. The orchestrator argued
that this accepted the lint interaction as an architecture premise. The rule added blank lines but
no content, and both size rules explicitly support `skipBlankLines`.

The orchestrator's argument won. Measurements with blank lines skipped cleared all 27 diagnostics.
Every affected file has 242 to 274 counted lines and every affected function has 39 to 48. A split
would add interfaces and navigation without reducing what a reader must understand. The final plan
keeps every reported module and function whole. Future architectural splits need evidence other
than this rule.

The same round corrected two inherited facts. At `541a484`, the tree has 2,325 sites, not 2,322,
and 27 diagnostics occupy 23 paths, not 27 files.

### Round 2: thresholds, commit integrity, surviving exceptions, and durable record

The planner considered 275/48 because those are the tightest passing content limits. Both agents
rejected that option. This branch should change whether required blank lines count, not tighten the
amount of content allowed. The existing 300/50 values remain and comments continue to count.

The orchestrator first proposed one commit containing both the whitespace and rule enablement. The
planner rejected it because a reviewer could no longer prove that the 261-file commit was
whitespace-only. The orchestrator conceded. The plan now makes the blank-line insertion and config
switch separate commits.

The orchestrator found three existing `max-lines` exceptions that remain above 300 counted lines.
The planner's earlier phrase "no file-scoped exception" was incomplete. The plan now says no new
exception, ratifies the two reasoned exceptions, and gives `exec-operation.ts` its missing reason.

The orchestrator also argued that the content-budget decision needs ADR-0041. The planner conceded.
The alternative is meaningful, reversal would recreate the 27 diagnostics, and a future reader can
otherwise mistake a 355-physical-line file for a broken gate. Unit 1 records the decision in the
repository rather than leaving its only rationale in ignored audit material.

### Round 3: accept a measured local cost or add many suppressions

Six independent readers reviewed the full mechanical diff. They objected to 78 of 2,325 inserted
blank lines, or 3.4 percent, all in compact guard, switch, or declaration groups. The orchestrator
first proposed a follow-up unit that would remove those blanks and add reasoned spacing
suppressions. It then withdrew that proposal. A reasoned `disable-next-line` is longer and louder
than the blank it removes, some groups would need several, and the rule has no configuration schema.
The planner agrees that a local plugin fork or roughly 90 to 120 suppression comments would cost
more than the measured problem.

The final decision accepts and records the 3.4 percent local readability cost. It adds no Unit 6,
no spacing suppression, and no local change to the verbatim vendored plugin. The stronger remaining
argument against adoption is now explicit: the project adds 2,325 physical lines and accepts those
78 worse placements to gain machine-enforced grouping in the other 2,247 placements. The complete
review found no broken comment association, literal, overload, or assertion grouping, and the net
reader verdict favored adoption.

### Round 4: execute the written plan literally

The orchestrator dry-ran all five units from their exact text. The resulting tree passed typecheck,
format, lint, vendor and protocol checks, 110 test files, and 780 tests. It still found three plan
faults. The Unit 5 example could be pasted as duplicate neighboring keys, the ADR index instruction
had no section anchor, and the release section treated an unbounded wait as the preferred path even
though the mechanical commit is regenerable. The planner accepted all three critiques. Unit 5 now
shows only inserted text, Unit 1 names the exact index anchor and Markdown format behavior, and
execution on the isolated branch at `541a484` is primary. Final-main regeneration happens later.

The planner then found one stale size directive in `src/supervisor/projects/turn-run.ts` and widened
Unit 3 to remove it while explaining the surviving `exec-operation.ts` exception. This keeps five
commits and gives one unit ownership of size-exception hygiene. The first explanation attributed the
staleness to blank-line skipping; Round 5 corrected that attribution.

### Round 5: audit every existing size directive

The orchestrator challenged both the attribution and the audit method. Direct deletion proved that
`turn-run.ts` already suppressed nothing at `541a484`; Unit 2 did not make it stale. It also proved
that `--report-unused-disable-directives` cannot be trusted for this file-level form. Removing each
of the nine size directives one at a time and running type-aware lint found exactly eight
load-bearing exceptions: three file ceilings and five test-function ceilings. The planner accepted
the correction, replaced script counts with Oxlint's 752, 307, and 332 file counts, and expanded the
ADR to list all eight survivors. No further exception cleanup belongs in this rollout.

The orchestrator signed after these factual corrections and re-ran the widened sequence. Unit 4
still contains exactly 2,325 additions, zero deletions, and 261 files, and final type-aware lint is
green.

### Final points conceded

The planner accepted the orchestrator's `skipBlankLines` alternative, complete eight-exception
audit, ADR requirement, release-order correction, and full-diff review evidence. The orchestrator
accepted the planner's separate whitespace-only and rule-enablement commits, the reason for
retaining 300/50, the widening of Unit 3, and the rejection of its proposed suppression unit. No
unresolved technical disagreement remains.

## Agreement

- Planner: signed this revision.
- Opus orchestrator `8bc2a04db5eb`: signed this revision after two complete green dry runs.
- Execution may begin: **yes**. The orchestrator started Unit 1 after signing.


## Post-execution record

The Opus orchestrator executed the signed five-unit sequence on `work/readable-spacing` and pushed
HEAD `4f7189cf7785db61edb9bc00a606b72777f857f5`, based on `541a484`:

| Unit | Commit | Actual change |
| --- | --- | --- |
| 1 | `3a34c50` | 2 files, 45 insertions |
| 2 | `1577cb2` | 1 file, 12 insertions |
| 3 | `4287d74` | 2 files, 3 insertions and 2 deletions |
| 4 | `2c785d3` | 261 files, 2,325 insertions and 0 deletions |
| 5 | `4f7189c` | 1 file, 6 insertions and 9 deletions |

The final `pnpm lint` reported zero warnings and errors. `pnpm verify` exited 0 with 110 test files
and 780 tests passing. The Unit 4 commit retained the measured 98 `src`, 119 `test`, and 44 `tools`
file split. Its committed `git diff --ignore-blank-lines --exit-code` was empty, and all 229
`oxlint-disable-next-line` comments remained adjacent to their targets.

The net size-suppression change is zero new suppressions, one existing bare suppression replaced by
a reasoned form, and one stale suppression deleted. The five surviving test-function exceptions
already carry written reasons on the immediately preceding line rather than after `--` on the
directive itself. Their reasons are:

- `test/access-cookie.test.ts`: each Access failure needs its own signed token, so one describe
  block covers them all.
- `test/access-owner.test.ts`: one describe block covers every owner-enforcement failure mode.
- `test/access.test.ts`: the test builds varied claim dictionaries to exercise the untrusted JWT
  boundary.
- `test/facet/generation-0/execution-env-loaded.test.ts`: one integration test drives four stock
  tools plus two host-side synchronization checkpoints.
- `test/github/credential-surfaces.test.ts`: one test drives the whole flow because the result is
  what the flow as a whole leaves behind.

Both reason forms put the explanation at the exemption site. Do not audit reason presence by
grepping directive lines alone: that makes all five test exemptions look bare, so the auditor must
read the immediately preceding comment. No sixth cleanup commit was added to rewrite a convention
that already works. ADR-0041 accurately lists all eight surviving exceptions; it does not spell out
the two comment forms, so this audit record preserves that implementation detail.

### Shared-worktree incident

During the first Unit 3 attempt, the planner's cold-review child mistakenly ran `git checkout --`
and `git restore --source=HEAD --staged --worktree --` on the two Unit 3 paths in the live shared
worktree. This happened after the execution worker's green gate and before its commit. Commit
`a8042bf` was therefore empty: its tree was identical to `1577cb2`. The orchestrator detected the
empty commit through post-commit diff checks, reset and force-pushed the branch back to `1577cb2`,
established exclusive worktree ownership, and reran Unit 3 as non-empty commit `4287d74`. No source
change was lost from branch history, and the final sequence was reverified.

Future cold reviewers must work from an archive or copy with independent Git metadata. A reviewer
must never run checkout, restore, reset, stash, add, or cleanup commands in an execution owner's
worktree. Every execution unit must verify the committed object itself with `git show --stat HEAD`
and `git diff --stat <previous> HEAD`; a green pre-commit worktree is not proof that the intended
commit contains the change.

While this branch executed, `origin/main` advanced by two release commits. The five commits remain
based on `541a484`. Follow the regeneration procedure above at integration time: cherry-pick the
three small judgment commits, regenerate Unit 4, and recreate Unit 5. Do not rebase or
conflict-resolve the generated whitespace commit.
