# E9 — Wave-2 preconditions: no credential path, dead provisioning entry, unexported compaction

Status: CONFIRMED by the root agent. Verifies review objections B4 and B5 before those tasks exist.
Feeds T6a/T6b and T7.

## 1. There is no GitHub credential path to build on (T6)

```
grep -rn "gh auth|GH_TOKEN|GITHUB_TOKEN" src scripts docs/agents/design   ->  zero matches
```

Nothing in the application reads, stores, or forwards a GitHub credential today. Goal criterion 3
requires repositories connected "through authorization separate from Access", with credentials that
never appear in tracked files, logs, browser responses, R2 maps or facet state. T6 builds that from
zero AND then needs a human at `github.com/login/device`.

That combination is why the review splits it: T6a is the unsupervised part (storage, variable-arity
catalog per E4, ownership resolution, routes, provisioning wiring, all testable with a fake
credential), and T6b is the single owner-run authorization, moved beside T12's other owner actions.
T6a needs a documented token-from-secret fallback for automated tests, or T9 and T11 inherit the
human blocker.

## 2. The provisioning entry point is dead code (T6)

`provisionProjectWorkspace` is defined at `src/workspace/provisioning.ts:111` and re-exported at
`src/workspace/index.ts:31`. It has NO other caller in `src/`.

So the function T6 must wire up already exists and is currently unreachable. That is good news for
sizing — the seam is there — but it also means nothing exercises it in production today, so its
behaviour is unproven by use.

## 3. Pi compaction is not exported; T7 must widen a GENERATED file correctly

`vendor/pi-v0.84.4/index.ts` line 30 exports `CompactionSummaryMessage` — a TYPE, and nothing else
compaction-related. The implementation lives in
`vendor/pi-v0.84.4/packages/agent/src/harness/compaction/{compaction,utils,branch-summarization}.ts`.

Goal criterion 5 requires a forced-compaction test that continues from saved Pi context, so T7 must
widen the vendored export surface. The trap: `index.ts` is GENERATED and checked inside the gate.
`tools/vendor-pi.mts` lists it among managed generated files, `checkVendorTree()` compares exact
contents and SHA-256 sums, `SHA256SUMS` pins it, and `verify:vendor` is the SECOND step of
`pnpm verify`. Hand-editing `vendor/**` therefore fails the gate by construction.

Correct procedure for T7: edit the generator's facade source, then run
`pnpm exec tsx tools/vendor-pi.mts --refresh-generated`. Never hand-edit `vendor/**`.
Do NOT attempt `--update`: it requires a clean upstream Pi checkout at tag `v0.84.4`, defaulting to
`/tmp/cf-stumble-pi-v0.84.4`, which this run cannot rely on.
A declaration-conformance check may also reject an export that does not exist upstream; if so,
record why and choose a supported surface rather than forcing it.

## Combined with E7's caveat

`ROUTE_MODEL` declares `contextWindow: 0` and `maxTokens: 0`. Compaction triggers read context-window
numbers. So T7 faces two independent obstacles to goal criterion 5: the capability is not exported,
and the model descriptor may make the trigger unreachable. Settle both before claiming that criterion.
