# Adversarial review of `roadmap-v0.md` — round 1 (opus)

Reviewer: root agent (`anthropic/claude-opus-5`), independent of the roadmap author and of the
`sol` reviewer. Base commit `d6ff2380487a60f410c568272635d99f30560d14`, working tree clean, no
tracked file modified. All file:line citations below were read by me in this session unless the
section says otherwise.

Inputs read: `oracle-summary.md`, `goal.md`, `roadmap-v0.md`, `architecture-critique.md`,
`.audit/v0/evidence/E1..E5`, `.audit/v0/STATE.md`, `docs/agents/design/feature-map.md`,
`docs/agents/adr/README.md`, `package.json`, `src/harness-build.ts`, `src/supervisor/supervisor.ts`,
`src/facet/generation-0/*`, `src/model-route.ts`, `tools/vendor-pi.mts`,
`vendor/pi-v0.84.4/{package.json,index.ts,UPSTREAM.json,SHA256SUMS}`, `clean-build-baseline.log`.

---

## 1. Verdict

**SHIP WITH FIXES — but do not dispatch the wave plan unchanged tonight.**

The plan's content is unusually good: the findings are real, the deletions are approved by
human-approved ADRs, and the empirical gates are honest. The defects are structural, not
intellectual. As written, one task (T1) mixes a cheap deterministic bug fix with an expensive
paid probe and then gates four tasks that need no platform fact at all, so a missing Cloudflare
authorization at 02:00 costs the entire night. T1 also does not leave behind any automated proof
of the E1 blocker it is supposed to close, so the fault can silently return. T7 deletes the only
code in the repository that produces a diff, which is required by goal criterion 4 and by step 3
of the feature-map demo. T7 also edits a *generated* vendored file whose checker is inside
`pnpm verify`, so the task as scoped cannot pass its own gate. T6 needs a human at
`github.com/login/device` yet sits on the unsupervised critical path. Six roadmap edits, perhaps
thirty minutes of work, remove all of that. Make them first.

---

## 2. Blocking objections

### B1. T1 is two tasks, and its expensive half gates four tasks that do not depend on it

**Defect.** T1 acceptance 1–3 are deterministic, local, free, and testable
(`git archive` → install → build Pi → build map → compare two maps). T1 acceptance 4–6 need an
approved paid Cloudflare environment, a Computer container, a Worker Loader, and account
authorization. T1 is `L`/`opus-manager` and is the sole member of wave 0. Wave 1 (T2, T3, T4, T5)
lists `Dependencies: T1` for **all four**.

**Evidence.** T2 touches `src/supervisor/control/`, `src/routes/generations.ts`, `src/page/*`
— nothing in that set reads a module map or a Computer capability. T5 touches
`src/supervisor/threads/` plus three method bodies in `src/supervisor/supervisor.ts`
(`finishProjectTurn` at line 236, `abandonProjectTurn` at 248, `startProjectTurn` at 226); it is
pure Durable Object SQLite work. T8 is `Dependencies: T1` and is an R2 lifecycle rule. None of
those four can be invalidated by any outcome of T1 acceptance 4–6. The roadmap itself admits
T1's paid half can end in "blocked, not passed" (T1.6: "Paid authorization or account access
missing means blocked, not passed") — which under the current dependency graph means the whole
roadmap is blocked.

**Exact fix.** Split T1 and rewire:

| new id | scope | size | tier | deps |
|---|---|---|---|---|
| T1a Clean-commit build correctness | T1 acceptance 1, 2, 3 + the regression proof in B2 | M | `sonnet-implementer` | none |
| T1b Paid capability / build / load gate | T1 acceptance 4, 5, 6 | L | `opus-manager` | T1a |

Then set `Dependencies: none` on T2 and T5, `Dependencies: T1a` on T3 and T8, and
`Dependencies: none` on T4's local work with T4.1's paid clause moved to T1b's probe list.
Wave 0 becomes "T1a + T2 + T5 in parallel"; T1b runs beside them, and a paid failure stops only
T3/T7/T9/T12, not the night.

### B2. T1 as written does **not** durably fix or prove E1

This is the objection the caller asked for specifically. T1 gets the *diagnosis* right and the
*repair* roughly right, but its proof is unfalsifiable and it names none of the platform
assumptions the repair introduces.

**What T1 gets right.** T1.1 requires the build operation to "obtain the named commit, use the
lockfile, build Pi, then produce the module map from a clean checkout" and forbids borrowing the
parent `node_modules` or generated Pi output. That is the correct repair for
`src/harness-build.ts:30` (`buildCommand: "pnpm run build:module-map"`), whose plan
(`planHarnessBuild`, same file) runs exactly four steps — `provision`, `isolate`, `checkout`,
`build` — with **no install step and no `build:pi` step**, into a directory populated by
`git archive`, which cannot contain untracked `vendor/pi-v0.84.4/dist/`.

**Gap 1 — no automated regression. A worker can claim T1.1 and T1.3 without evidence.**
T1.1 says "Reproduce the oracle's clean-archive failure"; T1.3 says "Retain commands and outputs".
Both are one-time manual acts recorded in prose. Nothing is added to `pnpm verify`, so the exact
drift that created E1 recurs the moment anyone edits either side. The drift is structural:
`package.json` `verify` = `pnpm build:pi && verify:vendor && verify:project-protocol && typecheck
&& format:check && lint && build:module-map && build:loaded-execution-env-fixture && test`,
while the deployed build is the single string `"pnpm run build:module-map"` in a *different file*.
The local gate runs `build:pi` first, so the local signal is green forever.
**T1 must add:** (a) one `build:artifact` script in `package.json` that performs install →
`build:pi` → `build:module-map`; (b) `HARNESS_BUILD_CONFIGURATION.buildCommand` must be exactly
that script name; (c) a test in the local gate that asserts the `buildCommand` string names a
script that exists in `package.json` (cheap, catches renames); and (d) a gate-level clean-build
test that runs `git archive HEAD` into a temp directory with `HOME`/store isolated and
`node_modules` unreachable, runs `build:artifact`, and asserts a module map is produced. If (d)
is too slow for the ~11s gate, it must be a separate committed script that CI/T12 runs and whose
absence fails a documented checklist — not a paragraph in an evidence file.

**Gap 2 — "two independent clean builds" is not required to happen on Computer.** T1.3 says
"Two independent clean builds of one commit produce byte-identical canonical maps"; only T1.5
mentions Computer, and in the singular ("Computer builds the map"). Goal criterion 7 says
"Two clean **Computer** builds of the same labeled commit produce identical canonical module
maps." A worker can satisfy T1.3 with two `/tmp` builds on the manager's laptop and still leave
criterion 7 unproven. **Fix:** reword T1.3 to require two clean builds *in the paid Computer
container*, and keep a local two-build check as a fast pre-check only.

**Gap 3 — the repair's own platform assumptions are unnamed.** Adding install + `build:pi`
inside the container assumes things nobody has checked, and the oracle's local reproduction
actively hides them. `clean-build-baseline.log` shows `resolved 183, reused 183, downloaded 0`
— a **warm local pnpm store** — and shows a native install script running:
`.../koffi@3.1.6/node_modules/koffi install$ node ./cnoke.cjs -P . -D src/koffi --prebuild --release`.
In a fresh Computer container none of that is given. **T1 must probe and record, as named
acceptance items:** pnpm present and its version (lockfile is `pnpm-lock.yaml`, local pnpm
11.18.0); Node version (local run was Node 26.7.0); reachability of the npm registry from the
container (T1.4's "arbitrary ordinary internet destination" is not the same claim); whether
lifecycle/native install scripts are permitted and can compile (`koffi`/`cnoke`), or whether
`--ignore-scripts` is required and still yields a working `tsx`/`esbuild`; cold-store install
wall time and disk use, because that number sets the cold-build timeout that T9 and T12 later
depend on; and `git` availability inside the build container, which the existing `provision` step
already assumes.

**Gap 4 — the fix must not be undone by the `isolate` step's own race.** `planHarnessBuild`
emits `rm -rf ${directory} && mkdir -p ${directory}` for a directory keyed only by the commit,
so two same-commit builds delete each other's tree (the critique says this; T3.4 owns it). If
T1a's new install step lands inside that directory, the blast radius grows (a partially installed
`node_modules` deleted under a running esbuild). **Fix:** state in T1 that the isolate/rm policy
and the install location are decided together, or explicitly hand the race to T3 with a written
interface.

**Verdict on the caller's question:** T1 *would* fix E1 if a competent worker executed T1.1
literally, but T1 as written does not *prove* it, does not prevent the same drift from returning,
and does not test the container preconditions the fix now depends on. Add items (a)–(d) of Gap 1,
the Computer wording of Gap 2, and the six probes of Gap 3.

### B3. T7 deletes the only code in the repository that produces a diff — goal criterion 4 breaks

**Defect.** Goal criterion 4: "One real turn reads a file, edits it, runs the repository's check,
and shows tool activity, command output, **and a diff**". `feature-map.md` demo step 3: "…runs the
configured check, then **shows the diff** and command output."

**Evidence.** The diff exists only on the legacy buffered path:
`src/facet/generation-0/tools.ts:77` declares tool `git_diff`; `tools.ts:92,138` map it to
`{ kind: "git-diff" }`; `src/facet/generation-0/tool-execution.ts:141-151` runs it and formats
`git diff` stdout/stderr/exit code. That path is reached from
`src/facet/generation-0/request-handler.ts:78` (`if (path === "/turn")`) →
`runGeneration0Turn` (`turn.ts:180`). The real Pi path builds exactly four tools —
`createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`
(`src/facet/generation-0/pi-agent-turn.ts:61-68`). There is **no diff tool on the Pi path**.
T7.5 orders: "Delete the hand-written buffered `runGeneration0Turn` path, its custom transcript,
**duplicate tools**, and the old production `/turn` handler". `git_diff` is not a duplicate; it is
unique. After T7, the product has no diff, and no acceptance criterion in T7 or T9 requires one.
T10.2 and T11.1 say "render diff output" and "prove read/edit/check/diff" — they consume something
that no task is required to produce.

**Exact fix.** Add to T7 an acceptance item: "The Pi path can produce a repository diff for the
demo turn — either by keeping a diff tool on the Pi agent or by proving `bash` + `git diff`
returns the diff through a tool-result frame — and the frame's byte budget is large enough to
display a small real diff without truncating it to uselessness." Note the truncation risk
explicitly: the vendored Pi exports `truncateTail` (`vendor/pi-v0.84.4/index.ts`), and T7.3 only
promises "bounded displayable content". Then reword T7.5 to say *duplicate* tools are
read/write/edit/bash only, and `git_diff` may not be deleted without its replacement landing in
the same commit.

### B4. T7's vendored-Pi export path cannot pass `pnpm verify` as scoped

**Defect.** T7 scope names "`vendor/pi-v0.84.4/index.ts` plus its managed export tooling if a
vendored capability needs exporting". That file is **generated**, and `pnpm verify` checks it.

**Evidence.** `tools/vendor-pi.mts:198` lists `["index.ts", piFacadeSurfaceSource]` among managed
generated files. `checkVendorTree()` (`tools/vendor-pi.mts:600-623`) compares every managed file
against "its exact expected contents" and then compares SHA-256 sums; `SHA256SUMS:6` pins
`index.ts`. `verify:vendor` (`pnpm exec tsx tools/vendor-pi.mts --check`) is the **second step of
`pnpm verify`**. `tools/vendor-pi.mts:657` states the remedy: "Generated file … does not match its
template. Run `pnpm exec tsx tools/vendor-pi.mts --refresh-generated`". There is also a
declaration-conformance check against `upstream-surface.ts` (`SHA256SUMS:253`,
`tsconfig.declaration-conformance.json`), so an export that does not exist upstream may fail
independently. And T7.2 needs compaction, which is **not exported today**: `index.ts` exports only
the `CompactionSummaryMessage` type (line 30), while the implementation lives at
`vendor/pi-v0.84.4/packages/agent/src/harness/compaction/{compaction,utils,branch-summarization}.ts`.
So T7 certainly must widen the export surface.

**Exact fix.** Add `tools/vendor-pi.mts` to T7's scope, and add an acceptance item: "Export new Pi
capability by editing the generator's facade source and running
`pnpm exec tsx tools/vendor-pi.mts --refresh-generated`; never hand-edit `vendor/**`. If
declaration conformance rejects the export, record why and choose a supported surface."
Also warn: `--update` requires an upstream Pi checkout, clean, at tag `v0.84.4` /
commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`, defaulting to `/tmp/cf-stumble-pi-v0.84.4`
(`UPSTREAM.json`, `tools/vendor-pi.mts:27,565-571`) — `/tmp` is exactly what this run's own
`STATE.md` says gets cleared. Tell the worker not to attempt `--update`.

### B5. T6 requires a human at a browser, and it is on the unsupervised critical path

**Defect.** T6.2 defaults to "an owner-initiated gh device authorization in the workspace" — the
owner must open `github.com/login/device` and type a code. T6 is wave 2, and T9 → T10/T11 → T12 all
sit behind it. An overnight agent cannot complete it. T6's verification note admits it
("Production credential authorization is an owner action; missing authorization blocks that
acceptance item") but the wave plan does not act on the admission.

**Evidence.** No credential path exists to build on: `grep -rn 'gh auth|GH_TOKEN|GITHUB_TOKEN' src
scripts docs/agents/design` returns nothing. `src/workspace/provisioning.ts:111`
(`provisionProjectWorkspace`) is exported by `src/workspace/index.ts:31` and has no other caller in
`src/`. So T6 builds this from zero *and* then needs a human.

**Exact fix.** Split T6 into T6a (connected-project storage, variable-arity catalog, ownership
resolution, routes, provisioning wiring, all testable with a fake credential — unsupervised) and
T6b (the one owner-run authorization + private-repo clone proof). Give T6a a documented
`GH_TOKEN`-from-secret fallback for automated tests so T9/T11 are not blocked on a human. Make
T6b a wave-5 owner step alongside T12's other owner actions, or have the owner run it before
dispatch and hand the worker a live container.

### B6. Unacknowledged same-file writers in wave 1

The dispatch contract claims "Within a wave, the listed scopes do not overlap except the explicitly
partitioned T3/T5 Supervisor edits." That is false twice.

- **`src/supervisor/supervisor.ts` has three wave-1 writers, not two.** T3 (construction/workspace
  wiring), T5 (thread RPC wrappers), and T2 — because `controlGeneration(request: GenerationRequest)`
  is declared at `supervisor.ts:145` and `GenerationRequest` is imported at `supervisor.ts:5-9` from
  `./control/index.js`, whose `request.ts:13` carries `readonly requestId: string`. Removing the
  request ID changes that public type. The edit is small, but the merge is a third hand in the file.
- **`src/facet/generation-0/capabilities.ts` has two wave-1 writers.** T4 owns it for
  `ModelCapability`. T3 changes `src/workspace/` addressing, and `capabilities.ts:6` imports
  `WorkspaceRequest, WorkspaceResult` from `../../workspace/index.js` to define
  `WorkspaceCapability` (with a long doc comment describing the `/project`-era design).

**Exact fix.** Land T5 first (its diff is three method bodies plus `threads/`), then T3, then let
T2's type edit rebase last. State in the contract that `capabilities.ts` belongs to T4 in wave 1
and that `WorkspaceCapability` is frozen until T7 deletes it with the buffered path. Replace
"related tests" in T3's scope with an enumerated test list; as written it can reach
`test/facet/**`, which T4 also owns.

### B7. T11 is the only integration proof and is forbidden from fixing what it finds

**Defect.** T11: "Read production code but do not modify it in this task. Report defects to the
owning task instead of silently fixing them." By wave 4 every owning task is finished and its
worker is gone. The plan has no defect-return path and no reserved budget, so a real T11 finding
either stalls the release or gets waved through.

**Exact fix.** Either promote T11 to `opus-manager` with authority to land narrow fixes plus a
named regression test, or add an explicit T11-fix reserve owned by the same manager as T9, and say
which tasks' acceptance criteria are re-run after a fix. Also re-size: T11's six criteria span
threads, leases, generations, cache, credentials and property tests — that is not `M`.

### B8. Paid and irreversible steps have no preconditions

Tasks that spend money, deploy, or touch the owner's accounts: **T1** (Computer container, Worker
Loader, R2, model calls), **T3** (repeats T1's paid probe + a concurrency probe), **T4** (paid
model-event probe), **T6** (owner's GitHub account, real credential material inside a container),
**T8** (an R2 **deletion** lifecycle rule on a real bucket), **T9** (paid disconnect/deadline
probe), **T10** (needs a running deployed app for the browser test), **T12** (full deploy of the
release candidate, plus publishing a recording — the only step with irreversible *disclosure*).

Before any of these runs unsupervised overnight, all of the following must be true and are
currently unwritten:

1. A named non-production Cloudflare account or an environment whose Worker names, R2 bucket,
   Durable Object namespaces and Container are prefixed for this run, so nothing overwrites a
   resource the owner cares about. Today the roadmap says "an approved disposable paid
   environment" without naming it.
2. A spend cap or an explicit per-task probe budget, plus "stop on first paid failure and record"
   (T1.6 has this; T3, T4, T9, T12 do not).
3. Disposable GitHub repositories under a throwaway owner for every clone/push test, and a rule
   that no probe pushes to `sakompella/cf-stumble` — note `HARNESS_BUILD_CONFIGURATION.
   harnessGitRemote` is the real repo (`src/harness-build.ts`), and the build path clones it.
4. T8's R2 rule must be **prefix-scoped to `module-maps/`** and the task must first prove the
   bucket holds nothing else (T8.3 asserts this as an outcome but does not require checking the
   bucket's actual contents first). An age rule on a shared bucket is a deletion, and deletions
   are the one thing an overnight agent should not get wrong.
5. `scripts/deploy/check-config.sh` must run and pass before any deploy (T12.1 says "The config
   guard actually runs before deployment" — good; make it a hard precondition, not a criterion).
6. T12.7's publication must stay blocked until Q5 is answered by the owner. Keep it as written.

---

## 3. Task-level defects

| id | defect class | severity | required change |
|---|---|---|---|
| T1 | scope conflation (local fix + paid gate in one id) | blocker | split into T1a/T1b per B1 |
| T1 | unfalsifiable acceptance (1, 3) — no automated regression | blocker | add `build:artifact`, buildCommand↔script test, clean-build script per B2 Gap 1 |
| T1 | wrong venue for the reproducibility proof | blocker | T1.3 must say two clean **Computer** builds (goal criterion 7) |
| T1 | missing platform preconditions (pnpm, registry, native install scripts, cold-store time, disk, git) | major | add as named probes per B2 Gap 3 |
| T1 | interaction with the `isolate` `rm -rf` race left implicit | minor | state install location and hand the race to T3 in writing |
| T2 | hidden file dependency on `supervisor.ts` (`GenerationRequest`) | major | list `src/supervisor/supervisor.ts` type edge in scope; order after T5/T3 |
| T2 | acceptance 4 is an open design decision handed to `sonnet` | major | decide now: "already-ready candidate returns current status; no implicit re-preparation" — or raise tier |
| T2 | edits `src/page/{markup,element-ids,script-generations}.ts` that T10 rewrites in wave 4 | minor | restrict T2's page work to deleting request-id controls; forbid polish |
| T2 | false dependency on T1 | major | set `Dependencies: none` |
| T3 | size — identity + directories + provisioning + path adapters + a paid concurrency experiment | major | split T3.1–T3.3 (layout, deterministic) from T3.4 (concurrency experiment, paid) |
| T3 | duplicated ownership of the Access verified-scope widening with T6 | major | assign the `src/access/index.ts` scope change to T3 only; T6 consumes it |
| T3 | "related tests" unbounded, collides with T4 | minor | enumerate test paths |
| T3 | `PROJECT_ROOT` defined twice (`src/workspace/project/resolve.ts:11`, `src/facet/generation-0/execution-env-paths.ts:12`) — task says "seams", not "one owner" | major | require one owning module for the repository-relative root; both consumers read it (E3 agrees) |
| T4 | understated starting point: the route has **no** streaming interface at all (`src/model-route.ts:260` `this.env.AI.run(...)`, `ROUTE_MODEL.contextWindow: 0`, `maxTokens: 0`, `ZERO_USAGE`) | major | reword from "carry real model events" to "add a streaming interface across route → facet → RPC"; keep size L |
| T4 | ignores existing vendored assets | minor | require evaluating Pi's `streamSimple`, `createAssistantMessageEventStream`, `createGatewayBindingFetch` (`vendor/pi-v0.84.4/index.ts:33-40`) before writing a third adapter |
| T4 | paid clause blocks an otherwise-free task | major | move T4.1's paid proof into T1b's probe list; keep the local adapter work unblocked |
| T5 | correctly scoped; only conflict is `supervisor.ts` ordering | minor | schedule first in wave 1 |
| T5 | acceptance 3 says "durable thread identity **or** monotonic concurrency version" — two designs | minor | pick one now (durable thread id) so the sonnet tier is a fit |
| T6 | requires a human mid-run | blocker | split T6a/T6b per B5 |
| T6 | catalog arity is a **type** change, not data (`ProjectCatalog = readonly [Project, Project]`, 17 references over 5 files per E4) | major | say so in scope; name `resolveProject` as the choke point |
| T6 | ordering hazard with T3 | major | state that connecting a 3rd repo before T3 lands creates a 3rd container (`deriveProjectWorkspaceName` hashes `project.id`) |
| T7 | deletes the only diff producer | blocker | per B3 |
| T7 | edits a generated vendored file checked by `pnpm verify` | blocker | per B4; add `tools/vendor-pi.mts` to scope |
| T7 | compaction export does not exist yet | major | name it: only `CompactionSummaryMessage` is exported today |
| T7 | must move `GENERATION_0_SYSTEM_PROMPT`, `MAX_MODEL_CALLS` out of `turn.ts` before deleting it (`pi-agent-turn.ts:17` imports them) | minor | already implied; make it explicit so the deletion order is safe |
| T8 | applies a deletion rule to a real bucket without a contents check | major | require enumerating the bucket and scoping the rule to `module-maps/` first |
| T8 | `sonnet`/`S` but needs account access + docs + a probe | minor | keep tier, add "blocked, not passed" language copied from T1.6 |
| T9 | 8 acceptance criteria, 4 dependencies, sole member of wave 3 — the wall-clock bottleneck | major | allow the route/adapter skeleton to be written in wave 2 against frozen T5/T7 interfaces |
| T9 | inherits a cross-task deletion list from T7 | minor | require T7 to commit the list as a file, not prose in a handoff |
| T10 | "a real browser test" but the repo has **no** browser harness (`test/routes/page.test.ts` checks markup/headers/script syntax only) | major | make "commit a runnable browser harness" its own acceptance item and budget for it; the `control-ui` skill exists for this |
| T10 | needs a deployed running app (paid) for its harness | major | say which environment; local `wrangler dev` cannot prove Access |
| T11 | may not fix what it finds | blocker | per B7 |
| T11 | sized `M` for six integration areas | major | resize to L or split cache/generation cases from thread/lease cases |
| T12 | seven criteria = a release programme in one id | major | split T12a (procedure + deploy + paid re-probes) from T12b (demo, recording, release notes) |
| T12 | publication depends on unanswered Q5 | minor | already handled correctly; keep |

---

## 4. Wave collisions

| wave | file | tasks | fix |
|---|---|---|---|
| 1 | `src/supervisor/supervisor.ts` | T3 (construction), T5 (thread wrappers, lines 226/236/248/265), T2 (`GenerationRequest` type at 5-9 and 145) | serialize T5 → T3 → T2's type edge; the manager merges once, not three times |
| 1 | `src/facet/generation-0/capabilities.ts` | T4 (owner), T3 (via `WorkspaceRequest/WorkspaceResult` import at line 6) | freeze `WorkspaceCapability` in wave 1; T4 owns the file |
| 1 | `test/facet/**` | T3 ("related tests"), T4 ("focused adapter tests") | enumerate both test lists in the roadmap |
| 1→4 | `src/page/{markup,element-ids,script-generations}.ts` | T2 (wave 1) then T10 (wave 4 rewrite) | T2 deletes only; no layout work |
| 2 | managed-instructions path | T7 (reads them at turn start) and T3/T6 (who write them via `src/project-provision.ts`) | one exported constant, owned by T3, consumed by both |
| 2 | `src/workspace/host.ts` | T6 (owner), T7 (audits `WorkspaceHost.execute` callers) | already partitioned in prose; make T7's output a committed file so T9 does not re-derive it |
| 3→4 | `src/routes/index.ts` | T6, T9, T10 add routes in three waves | fine as sequenced; note it as the hub file |
| 4 | `test/routes/` | T10 (`page.test.ts`), T11 (everything else) | already partitioned correctly — keep |

Reordering that cuts wall-clock: run T1a, T2, T5 in parallel at `d6ff238` on night one while T1b's
paid gate runs beside them; start T3 as soon as T1a lands rather than waiting for T1b's Computer
probe; and pre-write T9's HTTP adapter against frozen T5/T7 interfaces during wave 2. That removes
one full serialization point (wave 0) and shortens wave 3.

---

## 5. Done-criteria coverage map

| # | criterion (short) | tasks | status |
|---|---|---|---|
| 1 | release commit passes `pnpm verify`; notes name SHA, Computer source/image pair, model route, deploy commands | T12.1, T12.2, T11 (verify at candidate SHA), T1.6 (pins) | covered |
| 2 | Access admits only the owner; two browsers share Supervisor/projects/workspace/generation/threads; unauth + cross-tenant fail | T3.1, T6.6, T11.5, T12.4 | **partial gap** — no task implements or locally tests the Access policy *restricted to the owner*; it first appears as deploy configuration in T12.1 and is only exercised in T12.4. Add an acceptance item to T6 (or T3) for the owner-only policy and a local rejection test. |
| 3 | ≥2 GitHub repos connected via authorization separate from Access; one workspace holds them + harness; git/gh use local creds outside repos; no credential leakage | T6.1–T6.5, T3.2, T3.4, T11.5 | covered, but gated on the human step in B5 |
| 4 | collapsible sidebar + streaming conversation; one real turn reads, edits, runs the check, shows tool activity, command output, **and a diff**, then reports saved completion | T10.1–T10.3, T9.1–T9.2, T7.1/T7.3, T12.3 | **GAP — the diff is unowned and is actively deleted by T7.5** (see B3). Everything else is covered. |
| 5 | one current Pi thread per project; one active turn; repo + managed instructions reach Pi; forced compaction continues from saved context; fresh thread clears conversation, keeps files | T7.1, T7.2, T5.4, T5.5, T3.5 | covered; T7.2's compaction depends on the unresolved vendored export (B4) |
| 6 | success = Pi terminal success + committed save; no credit for rejected/failed/truncated/cancelled/unsaved; tested lease fencing; paid disconnect/deadline evidence | T9.2–T9.5, T5.1–T5.3, T11.2, T12.5 | covered. Note `src/supervisor/eligibility.ts:140` currently credits any `body-completed` with status < 400 — T9.3 addresses it; make the eligibility change explicit in T9's scope list. |
| 7 | two clean **Computer** builds → identical canonical maps; cold hit loads without rebuilding; missing/corrupt map rebuilds under the same identity; age rule configured; failed builds do not change the active generation | T1.3, T1.5, T8.1–T8.4, T11.4 | **partial gap** — T1.3 does not require the two builds to run on Computer (B2 Gap 2) |
| 8 | second visibly different harness commit built, cold-checked, activated with observed epoch; conversation continues; broken candidate fails while active serves; rollback preserves edit + thread; repeated submissions and active-target no-ops without a journal; stale epochs reject | T2.2, T2.3, T11.3, T12.3 | covered |
| 9 | paid restart/eviction preserves active selection, connected projects, threads, files; shared-container concurrency and GitHub credential persistence/reconnect recorded; no local fake as proof | T12.4, T12.5, T3.4, T6.4, T1.5 | covered |
| 10 | two-minute recording of the seven-step feature-map workflow; retain file, probe output, release notes; publish to approved destination or record the blocker | T12.3, T12.7 | covered; publication correctly blocked on Q5 |

Cut-line check: no task exceeds the cut line in `goal.md`. The nearest misses are T3.4 ("a bounded
conflict or a narrow serialization policy") and T9.5 (deadline + reconciliation), both of which can
grow into schedulers if a worker over-reads them — add "no alarm, no scheduler, no queue framework"
to T3.4 as T9.5 already says.

---

## 6. Where the plan is right — do not change this

- Starting with a paid gate instead of more UI. The audit trail supports it:
  `.audit/paid-runtime-evidence.md` and `scripts/probe/evidence/result-1788408728.json` cover R2 and
  Workers AI only.
- T2 as a pure deletion. ADR-0030 is **human-approved** and says exactly this: "the Supervisor
  applies generation requests directly and does not keep a request-deduplication journal"
  (`docs/agents/adr/README.md`). The critique's "do not replace the journal with a command bus or
  event store" is the right guardrail.
- T3 implementing ADR-0038/ADR-0039, both **human-approved**. This is deferred implementation, not
  re-litigation.
- T5 before T9. E2 is right that the lease-aware methods (`startTurnWithLease`,
  `finishTurnWithLease`, `abandonTurnWithLease` in `src/supervisor/threads/store.ts:70,74,124,138`)
  have no caller anywhere in `src` or `test`, and that the fix direction is to make the client
  surface lease-aware and delete the unfenced variants — not the reverse.
- Treating platform behaviour, timing and container concurrency as experiments rather than owner
  questions, and giving reversible product questions explicit defaults.
- "Record the disproof rather than adding a fake or a second cache identity" (T1.6). That single
  sentence is what makes the paid gate honest. Keep it verbatim, and copy it to T3.4 and T4.1.
- T11 being independent of the page author, and T10/T11's `test/routes/` partition.
- Refusing automatic repair, known-good promotion, provider pickers and background turns.

---

## 7. Review of the architecture critique

Claims I checked and confirmed: the four separate turn methods (`supervisor.ts:226,236,248,265`)
with no joining interface; the unkeyed thread path; `body-completed` crediting
(`src/supervisor/eligibility.ts:140`); the second turn loop reachable at
`request-handler.ts:78` → `turn.ts:180`; `src/workspace/provisioning.ts` having no application
caller; the duplicated `PROJECT_ROOT`; `ROUTE_MODEL` declaring zero context and zero usage; the
`rm -rf` build directory and the PID-lock provisioning script in `src/harness-build.ts`.

Where I think the critique is wrong or overstated:

1. **"The model route buffers output" is not merely understated — it misdirects T4's sizing.**
   There is no incremental interface to buffer: `ModelRoute.run` awaits `this.env.AI.run(...)`
   (`src/model-route.ts:260`) and resolves one finished message. E5 says this correctly; the
   critique's wording is what let T4 read like an adapter tweak. Not a factual error, but it
   produced a scoping error.
2. **"Duplicate tools" (finding 4 / T7.5) is factually wrong for `git_diff`.** Three of the four
   legacy tools duplicate Pi tools; `git_diff` does not exist on the Pi path. This single word is
   the cause of blocking objection B3.
3. **"Pi now uses its default tool scheduling" is unverified in this tree.** `grep -rn toolExecution
   src vendor/pi-v0.84.4/*.ts` returns nothing. T3.5's instruction "Do not solve workspace
   contention by restoring `toolExecution: "sequential"` globally" is written against a setting I
   cannot find. Either cite the file:line (it may be a Pi-internal default) or delete the
   constraint; an unsupervised worker will waste time hunting it.
4. **The critique under-costs its own page recommendation.** It says `src/page/` is "an adequate
   status prototype" and that real browser tests should arrive "as streaming is added", without
   noting that no browser harness exists at all. That omission is why T10 looks like one task.
5. **It does not mention the vendored-Pi export machinery** (`tools/vendor-pi.mts`, `SHA256SUMS`,
   `upstream-surface.ts` conformance) even while recommending "a small supported export if needed".
   That is the B4 landmine.
6. **No finding re-litigates a human-approved ADR.** I checked the index: 0026, 0027, 0030, 0033,
   0034, 0037, 0038, 0039 are human-approved and every ranked finding implements one of them.
   ADR-0034's reproducibility assumption is correctly treated as falsifiable rather than reopened.
   I agree with the critique's own conclusion on this point.

---

## 8. What I could not verify, and why

- Every paid claim. I ran no `wrangler`, no deploy, no Computer container, no model call, and I
  have no account access. Cold/warm build times, disconnect propagation, container concurrency,
  Loader behaviour, and R2 lifecycle syntax are all unverified by me.
- Whether the Computer image contains `pnpm`, `node`, a C toolchain, `git`, or `gh`, and whether it
  can reach `registry.npmjs.org`. This is the core of B2 Gap 3 and it is precisely why T1b exists.
- Whether two clean builds of one commit actually produce byte-identical maps. Proving it requires
  running the second build; I only proved the first build fails today (E1, reproduced in
  `clean-build-baseline.log`).
- Whether `@cf/zai-org/glm-5.3-flash` through the Workers AI binding can stream text and tool calls
  at all, and whether `low` reasoning effort with `thinkingLevel: "off"`
  (`src/model-route.ts:7`, `pi-agent-turn.ts:46`) is good enough for the criterion-4 coding turn.
  E5 flags the same risk. This is the single largest unpriced product risk in the plan.
- ADR-0031's fixture-attribution limitation currency (T9.8 claims it is stale). I read the ADR index
  entry, not the ADR body.
- `docs/agents/design/computer-integration.md` and `slices.md` status claims that T1/T3/T12 are told
  to update — I did not read them.
- Wall-clock and cost estimates for any task. The roadmap gives sizes, not durations, and I have no
  basis to convert them.
- Two verification subagents (`claim-verifier`, `doc-verifier`) were still running when I wrote
  this file; every claim above rests on my own reads, not on theirs. If their findings contradict
  anything here, that goes in round 2.

---

## 9. Safe to dispatch now

Question: of T2, T4 and T5, which can be implemented immediately at `d6ff238` without waiting for
T1's paid proof, and which would be wasted work if T1 disproved a platform assumption?

**T5 — dispatch now. Unconditionally safe.** It touches `src/supervisor/threads/store.ts`,
`project-threads.ts`, three method bodies in `supervisor.ts`, and `test/supervisor/threads/`. All
of it is Durable Object SQLite and plain values. No Computer, no R2, no Loader, no model. E2 has
already located every call site, so the diff is known before the worker starts. No T1 outcome —
build failure, non-reproducible map, absent capability — changes a single line of it. Dispatch it
first, because it also clears the `supervisor.ts` merge hazard for T3 (B6).

**T2 — dispatch now. Safe, with one small waste risk that is avoidable.** ADR-0030 is
human-approved, the target files are `src/supervisor/control/`, `src/routes/generations.ts` and the
page's generation script. Nothing in it depends on any platform fact. The stated `Dependencies: T1`
is fictional. The one avoidable waste: T2's edits to `src/page/markup.ts`,
`src/page/element-ids.ts` and `src/page/script-generations.ts` land in files T10 rewrites in wave 4,
so restrict T2 to *deleting* the request-id controls and their tests, and forbid layout work.
Before dispatch, resolve T2 acceptance 4 (the already-ready-candidate question) — as written it
hands a design decision to a `sonnet-implementer`.

**T4 — dispatch the local two-thirds now; hold acceptance 1's paid clause.** The Pi-facing side is
fully determined at `d6ff238`: the event types are vendored and pinned
(`AgentEvent`, `StreamFn`, `AssistantMessageEventStream` in `vendor/pi-v0.84.4/index.ts`), and the
adapter can be built and tested against a deterministic provider adapter today. Acceptance 4's
context/output limits are a pure fix to `ROUTE_MODEL` (`contextWindow: 0`, `maxTokens: 0`,
`ZERO_USAGE` today). None of that needs T1.

**Which would be wasted if T1 disproved a platform assumption.** Take T1's three possible
disproofs in turn:

1. *The Computer container cannot run install + `build:pi`* (no pnpm, no registry egress, native
   install scripts blocked). The build moves out of the container — a prebuilt artifact, a
   different image, or a changed build seam. This invalidates parts of T1's own design, T3.4 and
   T8/T11's cache cases. **It does not touch T2, T4 or T5.**
2. *Two clean builds are not byte-identical.* ADR-0034's assumption falls, artifact identity is
   reconsidered, T8 and T11.4 change. **T2, T4 and T5 are untouched.**
3. *Computer cannot deliver a per-turn RPC capability to a loaded facet, or the facet cannot reach
   the internet.* This is the severe case: T3, T7, T9 and most of the product change shape. Even
   then, **T5 survives intact** (thread state is Supervisor SQLite, not Computer), **T2 survives
   intact** (generation control never touches Computer), and **T4 survives in the majority**,
   because the model route is a Worker-side binding whose paid path is already proven by
   `scripts/probe/evidence/result-1788408728.json`.

So the only real wasted-work exposure among the three is narrow and it is **not** a T1 risk at all:
if the fixed Workers AI route cannot stream tool-call deltas, Q6 reopens and T4's provider-facing
half is rewritten (its Pi-facing half and its tests survive). That risk is cheap to retire and
should not wait for T1's expensive Computer gate. **Run a five-minute paid smoke probe of
`env.AI.run("@cf/zai-org/glm-5.3-flash", { stream: true, tools: [...] })` before dispatching T4**,
record whether text deltas and tool-call fragments arrive incrementally, and dispatch T4 against
the observed answer.

Recommended immediate dispatch set at `d6ff238`: **T5, then T2 (deletion-only page scope), plus T4
minus its paid clause**, with T1a running in parallel and T1b queued behind whatever paid
authorization the owner grants.
