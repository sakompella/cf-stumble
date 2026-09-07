# cf-stumble overnight completion plan

This plan takes cf-stumble from its tested Supervisor and fixture main facet to the version 0 demo in `docs/agents/design/feature-map.md`. Run one overnight job at a time. Each job starts from a green commit, changes one part of the system, runs its named checks, writes one decision-log row, and commits only when the checks pass.

The two paid deployments are operator checkpoints. An unattended worker prepares them but does not deploy. The operator starts each checkpoint after reviewing the exact command, resources, and target environment.

## Program checklist

- [x] Durable checklist path. `.audit/overnight-completion-plan.md`.
- [x] Durable objective. Deploy one tenant-aware coding agent that completes a repository edit, preserves sessions and project files across generation changes, rejects a broken candidate, activates a passing candidate, and rolls back without losing tenant state.
- [x] Done predicate. `test -f tools/verify-version0.mts && pnpm verify && pnpm exec tsx tools/verify-version0.mts --evidence .audit/version0-acceptance.json`.
- [x] Named loop. `cf-stumble-overnight-audit`.
- [x] Predicate. `test -f tools/verify-version0.mts && pnpm verify && pnpm exec tsx tools/verify-version0.mts --evidence .audit/version0-acceptance.json`.
- [x] Cadence. Tick after each overnight job and after each paid checkpoint. Review the latest commit and decision-log row before starting another job.
- [x] Arm it. `/Users/aditya/.agents/skills/poteto-mode/scripts/loop/loop --repo . arm cf-stumble-overnight-audit --objective "Deploy the version 0 coding-agent demo from docs/agents/design/feature-map.md." --predicate "test -f tools/verify-version0.mts && pnpm verify && pnpm exec tsx tools/verify-version0.mts --evidence .audit/version0-acceptance.json" --interval 3600`.
- [x] Manual tick. `/Users/aditya/.agents/skills/poteto-mode/scripts/loop/loop --repo . tick cf-stumble-overnight-audit`. The initial observation was red, as expected.
- [x] Recovery. The loop was cancelled for this pause. Re-arm it before resuming. Run `/Users/aditya/.agents/skills/poteto-mode/scripts/loop/loop --repo . unlock` only when `status` confirms that the local lock owner is dead.
- [x] Optional host adapter. No host goal is required. An operator may create one from the durable objective and done predicate before execution.
- [x] Decision trail. `.audit/overnight-completion-decisions.tsv` uses the `show-me-your-work` template. Append one row for every completed job, reverted attempt, paid result, or blocker.
- [x] GitHub predicate. Skipped for this pause because no pull request was opened. Before a later pull request lands, run `/Users/aditya/.agents/skills/poteto-mode/scripts/watch-pr/watch-pr predicate merge-ready --pr <number>`.
- [x] GitHub evidence. Skipped for this pause because the program remains on local commits.

## Autonomous execution

1. Write the durable objective, checkable done predicate, evidence path, and completed or skipped steps before the first iteration. Done above.
2. Arm one named portable loop. The interval records the review cadence and does not schedule work. Done above.
3. Make the smallest change justified by current evidence. Verify the unit, record the result, and commit only when the predicate advances.
4. Handle reversible discoveries without waiting. Put unrelated fixes in separate work and return to the predicate.
5. Stop only when the predicate passes or a paid deployment, irreversible action, or evidenced dead end requires the operator.

The coordinator owns briefs, decisions, verification, and integration. Code-writing agents own isolated worktrees. Every worker reads `/Users/aditya/.agents/skills/poteto-mode/SKILL.md`, receives the exact base SHA, and reports its branch, head SHA, commands run, and deviations.

Update `.audit/overnight-handoff.md` after each completed job, failed verifier, design pivot, worker replacement, and paid gate. Record the current commit, active worker, last check, blocker, and exact resume action before context compaction.

## Throughput checkpoint

- [ ] Blocking first steps. Finish Night 1 and Night 2 before the first paid checkpoint. The paid checkpoint must pass before any code depends on Computer capability transport or model egress.
- [ ] Independent workstreams. Night 3 and Night 4 touch separate areas after the paid checkpoint and may run in isolated worktrees. All other jobs run in dependency order.
- [ ] Shared mutable state. One worker owns each worktree. No two workers edit `src/worker.ts`, `wrangler.jsonc`, the vendored trees, or the same pnpm lockfile at the same time.
- [ ] Smallest safe decomposition. Keep the Pi turn, the Computer adapter, tenant routing, and the page in separate jobs. Each has a different failure boundary and a different matching test.

## Night 1: vendor the pinned Computer package

Status at pause: partial branch `pi-agent-4c1236bb-9849-47e` at `34678ff`. Do not merge. The commit omits all 78 tracked `dist/` files because the repository-wide `dist/` ignore matched them. Its manifest names files that are absent. It also lacks the required two-build determinism check and leaves optional peers in metadata, which expanded the lockfile. A fresh worker should repair and verify this branch.

- [ ] Depends on. Current `main`, ADR-0026, and a clean `pnpm verify`.
- [ ] Execution playbook. Feature inside an Autonomous run. Use a clean worktree and commit one green unit.
- [ ] Data shape. Define one `ComputerPin` value with the source commit and image digest. Generate the package from that value. Do not copy the pin into several scripts.
- [ ] Change. Add `tools/vendor-computer.mts`, `vendor/computer/`, its workspace package, pin metadata, and focused tests under `test/vendor/`. Update the workspace, formatter, linter, and dependency files only as required.
- [ ] Lever. `tools/vendor-computer.mts --check` verifies the pin, generated file set, license, runtime imports, and package build. The command must fail after a deliberate vendored-byte change and pass after restoration.
- [ ] Evidence. Run the vendor check, the package build, a Worker-target bundle check, the deliberate tamper check, and `pnpm verify`.
- [ ] Completion. The repository imports the pinned Computer package without reaching unpublished npm packages. The full gate passes, and the job commits the checker with the generated package.
- [ ] Stop. Stop with the full build output when the pinned source cannot produce a Worker package, an unpublished dependency remains external, or a Node-only import reaches the Worker bundle. Do not add broad shims.

## Night 2: prepare the local P0 probe

Status at pause: architecture arena completed four candidates and an Opus judge. The final synthesis agent failed. Recover the candidate and judge text from `wf_655a10832504.workflow.jsonl`, then synthesize before writing code.

- [ ] Depends on. Night 1.
- [ ] Execution playbook. Feature inside an Autonomous run. Use a clean worktree and no paid deployment.
- [ ] Data shape. Define branded `TenantKey` and `HarnessCommit` values, a narrow `MainHarnessHostBinding`, and a plain `ProbeResult` that records each attempted operation, duration, and error.
- [ ] Change. Add a static `WorkspaceHost` Durable Object, the loopback proxy required by the pinned Computer source, one restricted model-egress entrypoint, a tiny probe main facet, local tests, and a deployment probe command. Derive both Durable Object names from a test tenant key.
- [ ] Boundary. Pass only the workspace and model operations that the main facet needs. Keep Durable Object namespaces, account credentials, and arbitrary outbound fetch outside the facet.
- [ ] Evidence. Local workerd loads the probe facet, exercises the host proxy with a fake Computer port, rejects an unapproved outbound URL, and serializes `ProbeResult`. `pnpm verify` passes.
- [ ] Completion. `.audit/p0-paid-probe-command.md` contains the exact deployment command, resource names, rollback command, expected observations, and evidence destination. No resource has been deployed.
- [ ] Stop. Stop on `DataCloneError`, an unbounded outbound route, or a capability that requires handing a namespace or credential to mutable code. Record the observed and expected behavior.

## Operator checkpoint A: run the paid P0 probe

- [ ] Depends on. Night 2 and explicit operator approval for the named deployment and resources.
- [ ] Execution playbook. Prototype. This is a paid behavioral probe, not production code.
- [ ] Isolation. Use a dedicated Durable Object namespace, R2 bucket, Computer workspace name, and probe route. Do not import the production bindings.
- [ ] Observe. Confirm that Computer persists a file across restart, runs one container command, builds a module map, and loads a cold facet under the labeled commit. Confirm that the model route works and any other outbound destination fails.
- [ ] Evidence. Save raw command output, deployed SHA, resource names, cold and warm timings, and cleanup result in `.audit/p0-paid-result.md`. Append the decision log.
- [ ] Completion. Every P0 check in `docs/agents/design/feature-map.md` passes against the paid runtime, and the probe resources are either retained under their recorded names or removed with operator approval.
- [ ] Stop. Stop the program when capability transport, Computer persistence, build output, Worker Loader startup, or egress restriction fails. Do not continue from local substitutes.

## Night 3: replace SQLite artifacts with R2 and Computer

- [ ] Depends on. Operator checkpoint A.
- [ ] Execution playbook. Feature inside an Autonomous run.
- [ ] Data shape. Define a versioned `CachedModuleMapV1` parser and a `MaterializationResult` union for cache hit, rebuilt map, build failure, and invalid cache data.
- [ ] Change. Replace `harness_artifact_modules` in `src/supervisor/artifacts/` with one resolver that reads R2, rebuilds a miss through the proven Computer port, validates the result, writes R2, and loads the facet. Startup checks and serving use the same resolver.
- [ ] Idempotence. A repeated request for the same commit returns the same canonical map. A failed or interrupted rebuild leaves no valid-looking partial cache object.
- [ ] Evidence. Add tests for hit, miss then write, corrupt object then rebuild, build failure while the active generation keeps serving, Loader reuse, and two independent builds of one commit. Add a schema check that proves module source is absent from Supervisor SQLite. Run `pnpm verify`.
- [ ] Completion. Delete the SQLite artifact API and table in the same job. No compatibility adapter remains.
- [ ] Stop. Preserve both outputs and stop when two builds of one commit differ. That result disproves ADR-0034's reproducibility assumption.

## Night 4: add tenant-scoped session documents

- [ ] Depends on. Operator checkpoint A. It may run independently from Night 3 in a separate worktree.
- [ ] Execution playbook. Feature inside an Autonomous run.
- [ ] Data shape. Define branded `TenantKey`, `SessionId`, and `Revision` values. Define `DocumentReadResult` and `DocumentWriteResult` so a write is either committed at a new revision or rejected with the actual revision.
- [ ] Change. Add an opaque document table to `WorkspaceHost`. Store session documents under a tenant-local `sessions/<sessionId>` key. The host never parses Pi messages or generation-owned session fields.
- [ ] Concurrency. Different sessions may write concurrently. One session uses compare-and-swap and one active-turn record, so two clients cannot overwrite each other.
- [ ] Evidence. Test first write, read, successful update, stale revision, duplicate request, separate sessions, two-client race, restart, and Durable Object eviction. Run `pnpm verify`.
- [ ] Completion. The tested host API is the only durable session API exposed to mutable generation code.
- [ ] Stop. Stop if the implementation needs a shared working file, rename-based publication, or session parsing in the immutable host.

## Night 5: run Pi in a real main facet

- [ ] Depends on. Night 3 and Night 4.
- [ ] Execution playbook. Feature inside an Autonomous run.
- [ ] Data shape. Define `StoredSessionV1`, `TurnRequestV1`, and `TurnResultV1`. `TurnRequestV1` carries a `SessionId`, expected `Revision`, prompt, and idempotency key. `TurnResultV1` is completed, failed, aborted, or revision conflict. Each variant carries only fields valid for that outcome.
- [ ] Change. Add the Generation 0 source tree and build command. Construct the vendored Pi `Agent` with a scripted `StreamFn` and a fake `ExecutionEnv`. Implement deterministic `GET /` and buffered `POST /sessions/:sessionId/turn`. Save the session before returning success.
- [ ] Recovery. Parse every stored session at the generation boundary. When a prior tool call has no result, append one interrupted-tool result and never rerun the tool automatically.
- [ ] Evidence. A local Worker Loader test builds the real module map, passes `GET /`, completes one scripted tool turn, persists the session, resumes it after facet replacement, rejects a stale revision, and records one completed relay attempt. Run `pnpm verify`.
- [ ] Completion. Remove the production fixture from application construction. Keep fixtures only under test support.
- [ ] Stop. Stop if Pi needs edits inside the vendored tree, if the Worker bundle gains an unresolved Node import, or if a successful buffered turn can return before its session write commits.

## Night 6: connect Pi tools to Computer

- [ ] Depends on. Night 5.
- [ ] Execution playbook. Feature inside an Autonomous run.
- [ ] Data shape. Implement Pi's existing `ExecutionEnv` with parsed project-relative paths and typed `FileError` or `ExecutionError` results. Do not create a second tool protocol.
- [ ] Change. Connect read, write, edit, shell, and Git diff to the proven `WorkspaceHost` capability. Root paths under the tenant's configured project directory. Keep one verification command in tenant configuration.
- [ ] Boundary. Reject lexical path escapes before an RPC call. Convert every Computer rejection at the adapter boundary. Internal tool logic receives typed paths and results.
- [ ] Evidence. Test path escape rejection, read and write, edit, shell success, shell failure, Computer rejection, Git diff, and one full scripted edit-and-check turn. Run `pnpm verify`.
- [ ] Completion. The local acceptance fixture changes a real test repository, runs its check, returns the diff and output, and preserves the files after facet replacement.
- [ ] Stop. Stop if the adapter needs unsupported rename semantics, direct container access from the facet, or credentials inside the generation.

## Night 7: route verified tenants and expose JSON control

- [ ] Depends on. Night 6.
- [ ] Execution playbook. Feature inside an Autonomous run.
- [ ] Data shape. Parse a verified Access identity into a branded `TenantKey`. Derive it from the stable user claim and Access application ID. Define concrete request types for status, session turn, candidate submission, activation, rollback, and latest recovery report.
- [ ] Change. Replace `SUPERVISOR.getByName("facet-spike")` in `src/worker.ts`. Verify Access at the Worker boundary, derive the tenant key, and use it for both Supervisor and workspace-host names. Add buffered JSON routes. Never accept a tenant key from a URL, header, or body.
- [ ] Idempotence. Keep the existing request IDs and generation-control journal. A retried client request returns the recorded result.
- [ ] Evidence. Test missing and invalid identity, stable routing for two clients of one identity, isolation for two identities, caller-supplied tenant spoofing, separate sessions, request replay, stale epoch, and rollback rules. Run `pnpm verify`.
- [ ] Completion. Version 0 may allow only the owner's Access identity, but adding an allowed identity creates isolated Durable Objects on first use without a code change or tenant database.
- [ ] Stop. Stop when the documented Access claims do not supply a stable identity. Resolve that observable fact from Cloudflare's current docs or a paid token before choosing another key.

## Night 8: build the page and the acceptance driver

- [ ] Depends on. Night 7.
- [ ] Execution playbook. Feature inside an Autonomous run. Use `control-ui` for browser verification.
- [ ] Data shape. The page consumes the concrete JSON types from Night 7. Keep local UI state to the selected `SessionId`, expected `Revision`, active generation, current epoch, and pending request ID.
- [ ] Change. Add one no-framework page for session selection, prompt entry, buffered result, active generation, candidate status, activation, rollback, and the latest recovery report. Add `tools/verify-version0.mts` to check local gates and validate a paid evidence file against a fixed schema.
- [ ] Experience. Keep recovery controls in the immutable Worker page, so a broken generation cannot remove the rollback button. Show pending, conflict, tool failure, startup failure, and successful completion states.
- [ ] Evidence. Drive the page through the real Worker with `control-ui`. Capture the normal turn, two-client separate-session use, same-session conflict, failed candidate, activation, and rollback. Run `pnpm verify` and run `tools/verify-version0.mts` against a failing fixture evidence file to prove that the checker rejects incomplete releases.
- [ ] Completion. The page supports the two-minute demo without streaming, a frontend build system, an admin console, or a provider picker.
- [ ] Stop. Stop if the page requires a new transport or duplicates generation decisions already owned by the Supervisor.

## Operator checkpoint B: deploy and run version 0 acceptance

- [ ] Depends on. Night 8 and explicit operator approval for the production deployment.
- [ ] Execution playbook. Feature verification with `control-ui`. Deployment remains operator-approved.
- [ ] Deploy. Use the recorded Worker, Durable Object, R2, Computer, model, and Access configuration. Keep non-production resources separate from production bindings.
- [ ] Exercise. Complete a repository edit and check. Continue from a second client in another session. Restart or evict the runtime objects. Submit a broken candidate. Build and activate a passing candidate. Roll back. Confirm that project files and sessions remain.
- [ ] Evidence. Write `.audit/version0-acceptance.json` through the acceptance driver. Include the deployed SHA, tenant routing checks, generation labels, preparation-check IDs, relay attempt IDs, workspace checks, session revisions, screenshots, and command output paths.
- [ ] Completion. `test -f tools/verify-version0.mts && pnpm verify && pnpm exec tsx tools/verify-version0.mts --evidence .audit/version0-acceptance.json` exits zero.
- [ ] Stop. Stop on any failed acceptance assertion. Keep the prior deployment active and record the blocker. Do not weaken the checker to accept the observed failure.

## Morning review

After each overnight job:

1. Read the new decision-log row and the job's stop condition.
2. Inspect the commit and run the job's focused check.
3. Run `pnpm verify` when the job changed code.
4. Keep the commit only when the evidence matches the claim.
5. Tick `cf-stumble-overnight-audit` and record the predicate result.
6. Start the next job only when its dependencies are complete.

## Close

- [ ] Every checklist item is checked or marked skipped with a reason.
- [ ] The decision trail matches the commits and paid evidence.
- [ ] The done predicate passed and `.audit/version0-acceptance.json` records the deployed SHA.
- [ ] The two-minute demo is recorded from the accepted deployment.
