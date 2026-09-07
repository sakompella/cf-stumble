# Sol review: does the test suite prove anything?

Reviewed commit: `7818f8d`

## Method

I read the tests changed from `d6ff238` through `7818f8d`, the production code behind the five named seams, and the prior reviews and task reports. The diff adds or changes 100 files under `test/` and adds 244 test declarations while deleting older tests. I ran the required gate in `/private/tmp/cf-stumble-sol/tests`.

`pnpm verify` passed: 117 test files and 841 tests. I also made three temporary mutations, ran focused tests, and restored the worktree after each mutation. `git status --short` was empty when I finished.

## Findings, ranked by leverage

### 1. T13 repeats the exact T7 error through a more elaborate fake

**What is true.** The T13 tests still do not prove that production runs Git. The new fake imports the production command and assigns diff behavior to whatever string that constant contains. This is a circular oracle.

**Evidence.** Production selects `"git --no-pager diff HEAD"` in `src/facet/generation-0/turn-policy.ts:54`. The fake imports that same constant at `test/facet/generation-0/git-diff-exec-backend.ts:1` and says that any command equal to it gets the fake's private diff implementation at `test/facet/generation-0/git-diff-exec-backend.ts:44-46`. No child process runs; the file says so at `test/facet/generation-0/git-diff-exec-backend.ts:15-20`. The fake snapshots its own in-memory provider at `test/facet/generation-0/git-diff-exec-backend.ts:34-41` and generates the asserted unified diff itself.

I changed only `TURN_DIFF_COMMAND` from `git --no-pager diff HEAD` to `cat`. These two files still passed, 13/13 tests:

```text
pnpm exec vitest run   test/facet/generation-0/turn-diff.test.ts   test/supervisor/projects/project-turn.test.ts
```

The five false proofs are:

| test | fake shape | change that still passes |
| --- | --- | --- |
| `test/facet/generation-0/turn-diff.test.ts:61` | The model edits an in-memory file. `GitDiffExecBackend` recognizes the imported command constant and computes the expected diff itself. | Rename the production command to `cat`. |
| `test/facet/generation-0/turn-diff.test.ts:95` | The fake treats the imported command constant as a successful empty diff. | Rename the production command to `cat`. |
| `test/facet/generation-0/turn-diff.test.ts:132` | The fake creates both the large rewrite and the diff bytes used to check truncation. | Rename the production command to `cat`. |
| `test/facet/generation-0/turn-diff.test.ts:166` | The test sets the fake's `failure`; the fake returns it for the imported command constant. | Rename the production command to `cat`. |
| `test/supervisor/projects/project-turn.test.ts:74` | A loaded facet reaches a fake Workspace Host whose exec backend uses the same circular command rule. | Rename the production command to `cat`. |

The read-only case at `test/facet/generation-0/turn-diff.test.ts:111` is not in that list. It binds the separate rule that a read-only turn must not request a diff.

**Cost.** The review record says the old test “would still pass with `git diff` renamed to `cat`.” T13 claims to remove that fault, but the same mutation still passes. The suite proves that the harness requests its configured command and frames a fake diff. It does not prove the configured command is Git or that Git reports the workspace change.

**What to do.** Replace these five tests with one test outside workerd that creates a temporary Git repository, commits a file, runs the production command through a real process adapter, changes the file through the production workspace path, and asserts the emitted frame. Keep the read-only policy test and the separate frame-bound tests if they use the real command result. At minimum, the fake must recognize the literal required command independently of the production constant, so changing production to `cat` makes it red.

### 2. No test crosses the streamed model route entrypoint

**What is true.** T4 has useful parser and adapter tests, but none invokes the production `ModelRoute.runStream` entrypoint. The suite can stay green while that method always throws.

**Evidence.** The deployed entrypoint validates and calls the Workers AI binding at `src/model-route.ts:285-293`. `test/model-route-stream.test.ts` bypasses the class: its fake inference returns a test-provided byte stream at `test/model-route-stream.test.ts:39-44`, and the tests call the exported `streamModelEvents` helper directly, for example at `test/model-route-stream.test.ts:56-61`. The facet-side tests use another fake whose `runStream` returns a scripted stream at `test/facet/generation-0/route-stream.test.ts:41-55`. The module-map test only checks the old buffered `run` member at `test/facet/generation-0/module-map.test.ts:90-94`.

I replaced the body of `ModelRoute.runStream` with `throw new Error("streaming route deleted")`. All 21 focused tests passed:

```text
pnpm exec vitest run   test/model-route-stream.test.ts   test/facet/generation-0/route-stream.test.ts   test/facet/generation-0/module-map.test.ts
```

**Cost.** The parser may correctly process the fixture dialect while the actual service binding is disconnected. The real `@cf/zai-org/glm-5.3-flash` event dialect and incremental tool-call behavior also remain unverified because Q7 forbids the paid call.

**What to do.** Add a local entrypoint test that constructs or exports `ModelRoute` with a fake `AI` binding and invokes `runStream` through the same service-binding interface the facet uses. It must fail if `runStream` throws or stops calling `streamingBindingCall`. Then run the paid dialect probe after Q7 is approved. Do not remove the existing parser tests; they bind production parsing logic even though their provider bytes are fixtures.

### 3. The page tests do not run the page, and the promised browser harness is absent

**What is true.** `test/page/owner-page.test.ts` tests the HTML and JavaScript strings produced by the page modules. It does not test rendered behavior. The file admits this at `test/page/owner-page.test.ts:7-11`.

**Evidence.** The tests call `ownerPageHtml` and search or parse its text, starting at `test/page/owner-page.test.ts:26-45`. They never create a DOM, dispatch a click, feed an HTTP response, or inspect rendered output. I inserted an early `return` at the start of the production `onClick` helper at `src/page/script.ts:19`, which makes every wired button inert. All 12 page tests and all 7 page-route tests still passed.

The repository declares `pnpm harness:browser` at `package.json:21`, but `tools/browser-harness/run.mts` is absent at this commit. Running the command failed with `ERR_MODULE_NOT_FOUND`. Thus the note in `AGENTS.md` describes a harness that is not in `7818f8d`.

**Cost.** The green gate cannot see a page that never reacts to Send, Cancel, Connect, Activate, Roll back, Fresh thread, or the sidebar toggle. It also cannot see narrow or wide layout failures. The static tests still have value: they bind CSP-friendly output, IDs, endpoint literals, and the absence of unsafe HTML APIs. They are not a rendered-page proof.

**What to do.** Restore and finish the browser harness before treating T10 as complete. It must serve the real page, click the controls, stream split NDJSON frames, check visible text/tool/diff/terminal output, test keyboard access, and exercise both viewports. Add `pnpm harness:browser` to the release evidence. Keep it outside the fast gate if its cost is intentional, but make the command exist.

### 4. The five goal-carrying seams have uneven proof

#### Lease, T5: bound locally

`test/supervisor/threads/turn-lease.test.ts:92-143` proves that a stale finish cannot save into a replacement turn, and `test/supervisor/threads/turn-lease.test.ts:121-143` proves that stale abandonment cannot free the replacement slot. These tests use the real Supervisor Durable Object and thread store, not a literal decision fixture. Removing the lease comparison at `src/supervisor/threads/decisions.ts:64-74` or accepting a mismatched lease would make them red. This seam is bound locally.

#### Credit predicates, T9b: bound locally

`test/supervisor/projects/turn-credit-flow.test.ts:67-93` proves save-before-credit and reads the durable credit ledger. The unsaved case at `test/supervisor/projects/turn-credit-flow.test.ts:114-129` and the successful non-turn relay at `test/supervisor/projects/turn-credit-flow.test.ts:180-189` separate completed-real-turn credit from HTTP success. Removing `threadSaveCommitted`, crediting before `finishTurn`, or merging the real-turn predicate back into generation eligibility would make these tests red. Production performs the save and predicate call at `src/supervisor/projects/turn-settle.ts:78-100`. This seam is bound locally.

#### Diff frames, T13: frame flow bound; repository diff not bound

The facet does deterministically request a post-turn diff at `src/facet/generation-0/facet-turn.ts:62-68`, and tests would fail if that request or the frame disappeared. Supervisor forwarding is also exercised with scripted frames at `test/supervisor/projects/turn-credit-flow.test.ts:95-111`. But no test binds the command to Git, for finding 1. There is no test that goes red when `git --no-pager diff HEAD` becomes `cat`. This seam has a decisive gap.

#### Streamed model route, T4: no end-to-end local test

The helper on each side has tests, but no test invokes `ModelRoute.runStream` at `src/model-route.ts:285-293`. The throwing mutation in finding 2 proves the gap. The real provider remains unverified. No test currently carries the whole seam.

#### Tenant workspace, T3a: bound above the Computer boundary

`test/supervisor/projects/project-turn.test.ts:97-121` proves two selected projects use different directories but one workspace name. The tenant separation case at `test/supervisor/projects/project-turn.test.ts:162-184` proves another Supervisor name selects another fake host. Production obtains one named capability and passes the selected project directory at `src/supervisor/projects/project-turn.ts:115-127`; the Supervisor derives the single name at `src/supervisor/supervisor.ts:125-143`. Adding the project ID back to the workspace name or passing the workspace root instead of `projectDirectory(...)` would make these tests red. The local boundary is bound. The actual Computer container, persistence, and eviction behavior remain unverified.

### 5. The green gate is a local code-quality and simulation result, not release evidence

**What is true.** The green gate proves exactly the commands listed at `package.json:22`: Pi build, vendor and protocol checks, TypeScript, formatting, lint, module-map and fixture builds, then the Node/workerd suite. It proves the local decision logic and several real Durable Object storage paths well. It does not open a browser or start a Computer container.

`scripts/probe/clean-build.sh` is separate from the gate. The script itself calls the result only a pre-check at `scripts/probe/clean-build.sh:13-14`, and both builds inherit the same host `PATH` at `scripts/probe/clean-build.sh:69`.

**Cost.** Green does not prove: a rendered page; Cloudflare Access in deployment; the Workers AI binding or its real stream dialect; Dynamic Worker Loader/facet behavior in the paid runtime; Computer persistence or eviction; `gh`, `tar`, GitHub and npm network access; two Computer builds; R2 hit/corruption/lifecycle behavior; actual browser disconnect propagation; or the release workflow. Q7 correctly keeps all paid claims unverified.

**What to do.** Report `pnpm verify` as a green local gate, nothing more. Run the separate clean-build probe as a host regression check. Require the browser harness and the named paid probes before closing their matching goal criteria.

## The fakes: disposition

Not every fixture is decorative. The model-route fixtures at `test/model-route-stream.test.ts:39-61` feed provider bytes into production parsing, so a parser regression breaks them. The scripted generation at `test/supervisor/projects/turn-run-helpers.ts:39-73` feeds frames into the production Supervisor settlement path, so a lease, save, parser, or ledger regression breaks those tests. These are valid contract tests, but neither proves its external producer.

The diff fake is different. It imports the answer to the question it claims to check and assigns the desired behavior to that answer (`test/facet/generation-0/git-diff-exec-backend.ts:1,44-46`). The five tests in finding 1 therefore assert behavior produced by the test fake rather than Git behavior produced by production. Those are the tests I would delete and replace.

## Page verdict

`test/page/owner-page.test.ts` tests the module's own generated HTML and JavaScript text, not the rendered page. Its syntax check only constructs a function and never calls it (`test/page/owner-page.test.ts:35-47`). The inert-click mutation passing all page tests is the direct falsification. At `7818f8d`, no runnable browser test replaces that missing evidence.

## Unverified items

No paid probe was run. Q7 remains open. A named disposable Cloudflare environment and spend approval would settle the real model, Computer, Loader/facet, Access, R2, persistence, eviction, and disconnect claims. A restored local browser harness would settle the page behavior without paid spend, except for Cloudflare Access itself.

## Verdict

**THE SUITE BINDS WITH GAPS — delete 5 tests.**
