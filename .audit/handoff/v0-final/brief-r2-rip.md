# Brief: cut R2 and store module maps in Supervisor SQLite (handoff decision 6)

You are a code worker for the cf-stumble v0 finishing run. The orchestrator merges; you do not.

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/r2-rip -b work/r2-rip origin/main
cd /home/aditya/wt/r2-rip
```

Work only there. `.audit/` is not in your worktree; read it from
`/home/aditya/repos/cf-stumble/.audit/`.

## Read first

1. `/tmp/cf-stumble-v0-handoff-2026-09-08.md`. Decision 6 is your task. The "demo that defines
   done" section holds the deletion rule.
2. `/home/aditya/repos/cf-stumble/.audit/v0/review-sol-simplify.md`, section "Decision 6". It is a
   reviewed design with file and line references, current Cloudflare limits, and a named atomicity
   mechanism. **Follow it.** If you disagree with a point, say so in your report with evidence
   rather than silently doing something else.
3. `/home/aditya/repos/cf-stumble/AGENTS.md`, `docs/agents/domain.md`, and
   `~/.agents/skills/poteto-mode/SKILL.md`.

## The correction you must know

Decision 6 says module maps "live in the existing, tested Supervisor SQLite artifact store". That
premise is false: no such store exists. `src/supervisor/artifacts/cache.ts` keeps module maps in
R2 only, and `src/supervisor/artifacts/index.ts` says in a comment that Durable Object SQLite
stores no module source. So this is a replacement, not a deletion. The owner's goal stands: build
on submission, store, load on activate and rollback, never rebuild for rollback.

## What to build

Per the reviewed design:

- A SQLite `ModuleMapStore` on `DurableObjectStorage` replacing `ModuleMapCache`. Store the
  existing canonical encoding (`encodeModuleMap`) as UTF-8 BLOB chunks no larger than 1 MiB, with
  a manifest row holding the harness commit, chunk count and byte count. A Durable Object row,
  string or BLOB may not exceed 2 MB, and one generated module can be larger than that, so do not
  use one row per module and do not use one row for the whole map.
- Write the manifest and every chunk inside one `ctx.storage.transactionSync`, so a restart sees a
  complete map or no map. Do not write `BEGIN`. The repository already uses `transactionSync` in
  `src/supervisor/generations/index.ts`.
- A read validates the manifest count and contiguous chunk indexes and fails closed. It never
  rebuilds.
- Split `HarnessArtifacts` into `prepare` (submission time; may build when nothing is stored) and
  `load` (read-only; never builds). Delete `resolver.ts` rather than keep the cache-hit,
  build-then-write result shapes. Remove the current path that lets startup continue after a store
  write fails: a persistence failure must fail preparation, so a `ready` generation always implies
  a stored map.
- Delete `MODULE_MAPS` from `src/supervisor/supervisor.ts`, `src/supervisor/env.d.ts`,
  `wrangler.jsonc` and `wrangler.test.jsonc`. `test/docs/test-config.test.ts` proves the two
  configs differ only by the AI binding, so change both.
- Delete the corruption-recovery rebuild path, the cache age rule, the double-build reproducibility
  gate and the SQLite-schema-deletion test, per decision 6.
- Delete `docs/agents/adr/0034-cache-rebuildable-module-maps-in-r2.md` and its entry in
  `docs/agents/adr/README.md`; `test/docs/adr-index.test.ts` checks that index. Read ADR-0028
  first: it defines the artifact and may need one sentence changed rather than deletion. Another
  agent is rewriting `docs/agents/design/*`, so leave the design documents alone and list in your
  report every R2 sentence you found there.
- Delete or rewrite the obsolete R2 probe in `scripts/probe/run.sh`.

## Tests

Replace `test/supervisor/artifacts/r2-binding.test.ts` with SQLite coverage: persistence across a
Durable Object eviction, atomicity (a failed write leaves no partial map), a map larger than one
chunk, and the property the demo needs and the suite does not yet state, that **rollback loads the
stored map with a builder that always fails**. Rewrite the direct R2 setup in
`test/routes/generation-candidates.test.ts`, `test/supervisor/artifacts/generation-preparation.test.ts`
and `test/supervisor/artifacts/module-map-resolver.test.ts`. Keep the properties that a failed
candidate leaves the active generation serving and that a startup-check failure fails the
candidate.

Do not add features. Do not rename surviving concepts. Do not touch the page, the turn path or the
Access boundary.

## The gate

`pnpm verify` green before every commit; `.githooks/pre-commit` runs it. `pnpm format` fixes
formatting. Wrap every long command in `timeout` and redirect output to a file. Rebase on
`origin/main` before you push and verify again. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/r2-rip`.

One commit if it is one thought; otherwise a small ordered series where each commit passes the gate
alone. Message style: read `git log --oneline -20` and match it.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 500 words:
branch and SHAs, `git diff --stat origin/main`, the schema you chose and why, how atomicity is
enforced and which test proves it, every judgement call, the `pnpm verify` result line, and
anything in the design you found wrong.
