# Review: simplification commits and SQLite module-map decision

## Scope and verification

I reviewed `27d85f0` and `0dd7c0b` on `work/simplify` against owner decisions 8 and 9. I also traced the module-map submission, startup, serving, activation, and rollback paths for decision 6.

`pnpm verify` passed on this branch: 118 test files and 843 tests. A focused run of `test/supervisor/naming.test.ts` also passed. Workerd prints the expected uncaught constructor exception during the negative test. At verification time, the only working-tree residue was the pre-existing untracked `tools/devbox/` directory. An unrelated uncommitted change to `src/workspace/host.ts` appeared after the review; I did not make or review it.

## Commit `27d85f0`: caller-supplied-tenant guard

**Verdict: do not merge as-is.** Amend the one stale contract below into this commit. After that deletion, the commit is self-contained and should merge.

### Blocker

- `src/access/index.ts:198-203` still says that `authenticateAccessRequest` refuses three kinds of request, including a request that tries to name its own tenant. The commit deletes that refusal. The comment now promises behavior that the function does not have. Change "Three" to "Two" and delete the tenant-naming clause. This is part of the guard deletion, so it belongs in the same revertible commit.

### Scope review

The diff otherwise follows decision 8 exactly:

- It removes `TENANT_FIELDS`, `TENANT_HEADERS`, `suppliesTenantField`, and the early refusal formerly at `27d85f0^:src/access/index.ts:59-81,238`.
- It removes `"caller-supplied-tenant"` from `AccessRequestResult` at `src/access/index.ts:51-57` and removes the corresponding 400 response branch from `src/worker.ts:12-17`.
- It deletes all of `test/access/tenant-selection.test.ts`, as the decision names.
- It deletes exactly the cross-identity and cross-audience cases from `test/workspace-names.test.ts:15-17,29-40`. Removing the helper's now-unused audience parameter is cleanup required by those deletions, not unrelated behavior.
- It keeps the owner check at `src/access/index.ts:57-82` and keeps `deriveSupervisorName` in the admitted path at `src/access/index.ts:187-192`. No surviving branch became unreachable, and no deleted guard symbol or tenant header remains.
- This commit adds no test. Its test changes are the deletions the owner requested.

### Should-fix outside this commit

Decision 8 also says to remove invited-user and cross-tenant claims from documentation and the release gate. Those claims still exist at `docs/agents/design/feature-map.md:51-52,83-93,190-193` and `docs/agents/design/computer-integration.md:39-42,76-78`. Do that in the separate plan-document commit. Adding prose edits to `27d85f0` would violate the owner's clean-revert requirement.

## Commit `0dd7c0b`: unnamed Supervisor refusal

**Verdict: merge.** I found no blocker, should-fix item, or nit in this commit.

`src/supervisor/supervisor.ts:131-138` replaces the `ctx.id.toString()` fallback with the requested constructor failure and uses the name only after it has been proved present. The commit changes no other behavior and leaves no dangling fallback branch.

The tests assert the property through the real workerd Durable Object binding:

- `test/supervisor/naming.test.ts:9-15` creates the object through `get(newUniqueId())` and proves first use fails in construction.
- `test/supervisor/naming.test.ts:17-23` proves a named object still constructs and serves. The exact error text at lines 12-14 is an implementation detail, but here it distinguishes the intended constructor refusal from an unrelated startup failure. I would keep it.

### Raw-id call-path audit

The only tracked `SUPERVISOR.get(...)`, `SUPERVISOR.newUniqueId()`, or `idFromString(...)` path is the intentional negative test at `test/supervisor/naming.test.ts:10`. Production obtains the Supervisor by verified name at `src/worker.ts:33`. All other Supervisor test helpers use `getByName`. `wrangler.jsonc:13-15` and `wrangler.test.jsonc:17-19` declare the namespace binding but do not select an object. No surviving production or positive test path will hit the new throw.

## Decision 6: replace R2 with Supervisor SQLite

### Verdict

The premise in the handoff is false in the current tree. `src/supervisor/artifacts/index.ts:37-48` constructs an R2 `ModuleMapCache`, and its comment explicitly says SQLite stores no module source. This is a storage replacement, not an R2 deletion.

Still, I would honor decision 6. I would not ship the proposed one-row-per-module schema without a source-size bound. Use bounded byte chunks of the existing canonical module-map encoding, commit every chunk atomically, and make normal serving and rollback read-only. Keeping R2 is the smallest diff, but it does not satisfy the owner's explicit decision to cut R2 entirely.

### 1. Row shape and current Cloudflare limits

Cloudflare's current [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits) document these SQLite limits:

- 10 GB per SQLite-backed Durable Object on Workers Paid;
- 100 columns per table;
- unlimited rows per table, subject to the object's storage limit;
- 2 MB maximum for a string, BLOB, or table row;
- 100 KB maximum SQL statement length; and
- 100 bound parameters per query.

A per-module row is therefore not safe by construction. `src/facet/artifact.ts:45-62` accepts an arbitrary source string and enforces no byte limit. The current one-module `build/module-map.json:1` is already 942,366 bytes, with 911,709 UTF-8 bytes of source. Cloudflare also permits a [64 MiB uncompressed Worker](https://developers.cloudflare.com/workers/platform/limits/#worker-size), so platform-valid code can be much larger than one SQLite row.

The simpler safe representation is the canonical JSON map split into fixed-size BLOB chunks. Use `encodeModuleMap` from `src/supervisor/artifacts/module-map.ts:20-26`, encode it to UTF-8, and split it into chunks no larger than 1 MiB. A small manifest row can hold `harness_commit`, `chunk_count`, and `byte_count`; chunk rows hold `harness_commit`, `chunk_index`, and `bytes`. The entry module is already inside the canonical JSON. This reuses the existing parser and cannot cross the 2 MB row limit even when one generated module is large. It also avoids inventing SQL reconstruction rules for module names and entry selection.

### 2. Partial writes and the smallest atomic mechanism

Without atomic retention, a restart can leave only some module or chunk rows. That can fail in two ways. If the entry is missing, `MainHarnessArtifact.parse` reports `entry-module-not-found` at `src/facet/artifact.ts:111-126`. Worse, if the entry row is present but an imported module is missing, the parser can accept the incomplete map because it checks only the named entry, non-emptiness, and duplicate names at `src/facet/artifact.ts:80-126`. The Worker Loader then receives a broken generation. A rollback could move the live pointer to code that cannot mount, and the new rules forbid rebuilding it.

Wrap manifest replacement and every chunk insert in `ctx.storage.transactionSync`. The repository already uses that API at `src/supervisor/generations/index.ts:201-203`. Cloudflare's current [`transactionSync` documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync) says the callback is one transaction, rolls back if it throws, and supports synchronous `sql.exec` calls. Do not use `BEGIN`; Cloudflare says `sql.exec()` does not accept transaction statements. Insert or replace the complete map in one synchronous transaction. Then a restart observes either the old complete map, the new complete map, or no map.

A manifest count plus contiguous chunk-index validation makes a read fail closed if rows are later damaged. Do not rebuild on that error. The corruption-recovery rule is being deleted.

### 3. Types, calls, and the smallest decision-compliant change

The central changes are:

- Replace `ModuleMapCache` and its R2 errors in `src/supervisor/artifacts/cache.ts:7-79` with a SQLite `ModuleMapStore` that accepts `DurableObjectStorage` and exposes atomic `read` and `write` operations.
- Change `HarnessArtifacts` construction at `src/supervisor/artifacts/index.ts:42-64` and `src/supervisor/supervisor.ts:139-143` to pass `ctx.storage`, not `env.MODULE_MAPS`.
- Remove `MODULE_MAPS` from `src/supervisor/supervisor.ts:73-76` and `src/supervisor/env.d.ts:13-18`, and remove the bindings at `wrangler.jsonc:42-47` and `wrangler.test.jsonc:45-50`.
- Delete the cache-specific resolver behavior at `src/supervisor/artifacts/resolver.ts:29-65`. In particular, lines 60-65 currently let startup continue when a cache write fails. That is unacceptable once rollback cannot rebuild: persistence failure must fail preparation before a generation becomes ready.
- Split preparation from loading. `prepareGenerationStartup` at `src/supervisor/startup-check/index.ts:69-88` may read a complete stored map or build, validate, and atomically store a missing one. `HarnessArtifacts.activeModuleMap` at `src/supervisor/artifacts/index.ts:142-150` must only read stored bytes. It must never call a resolver that builds on a miss.
- Keep `handleGenerationSubmission` at `src/routes/generations.ts:134-157`: it already labels and then calls `prepareGeneration`. Keep `GenerationControl.execute` synchronous at `src/supervisor/control/index.ts:35-54`. A ready status will imply that the artifact was stored and passed startup. Activation and rollback need not gain another asynchronous build or storage API. The next mount reads the stored map only.
- Rewrite direct R2 setup in `test/routes/generation-candidates.test.ts:41-50`, `test/supervisor/artifacts/generation-preparation.test.ts:35-40`, and `test/supervisor/artifacts/module-map-resolver.test.ts:78-173`. Replace `test/supervisor/artifacts/r2-binding.test.ts:19-105` with SQLite persistence, atomicity, size-boundary, eviction, and rollback-with-a-refusing-builder coverage.
- Delete or rewrite the obsolete R2 probe at `scripts/probe/run.sh:114-155,184-195` and update the R2 claims in the current ADR/design/deploy documents. Decision 6 already directs deletion of ADR-0034's cache rule.

The smallest clean implementation can delete `resolver.ts` rather than preserve cache-hit/build/cache-write result types. `HarnessArtifacts` needs two operations: `prepare`, which may build only when submission finds no stored map, and `load`, which never builds. Keep the builder and module-map validation code. This is smaller and makes the no-rebuild rollback rule visible in the API.

There is no need to preload code during the activation transaction. The seven-step behavior requires the selected generation to serve from stored bytes. The existing ready-state invariant can guarantee that. Add a test that evicts the Supervisor, rolls back, then serves the earlier generation while a builder that always fails remains unused.

### 4. Demo dependency on corruption recovery

None of the seven demo steps depends on rebuilding corrupt storage. The corruption-only behavior is isolated at `test/supervisor/artifacts/module-map-resolver.test.ts:142-154` and `test/supervisor/artifacts/r2-binding.test.ts:59-78`.

The deliberately broken candidate in demo step 6 is different. It has a valid module map whose `GET /` response fails the startup rule. That behavior is covered at `test/routes/generation-candidates.test.ts:139-152`, and the active-generation guarantee is covered at `test/supervisor/active-serving.test.ts:96-119`. Keep those properties. Delete only the corrupt-object rebuild expectation. Demo step 7 needs the inverse guarantee: rollback loads the complete stored map without invoking Computer. The current suite does not state that rollback-specific property directly, so the SQLite replacement should add it.
