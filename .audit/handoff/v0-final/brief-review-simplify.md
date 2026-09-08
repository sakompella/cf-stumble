# Brief: review two simplification commits and one design decision

You are the review role for the cf-stumble v0 finishing run. Model `openai-codex/gpt-5.6-sol`.
You are read-only. Do not edit, commit, or push anything in the repository.

## Context to read

1. `/tmp/cf-stumble-v0-handoff-2026-09-08.md` in full. Its "Owner execution directives" section is
   the highest authority; decisions 8 and 9 govern the two commits below, decision 6 governs the
   design question.
2. `/home/aditya/repos/cf-stumble/.audit/v0/realignment-notes.md`.
3. The repository at `/home/aditya/repos/cf-stumble`, branch `work/simplify`. Read-only.

## Part 1. Review the two commits

```
git -C /home/aditya/repos/cf-stumble log --oneline b0eef15..work/simplify
git -C /home/aditya/repos/cf-stumble show 27d85f0
git -C /home/aditya/repos/cf-stumble show 0dd7c0b
```

- `27d85f0` deletes the caller-supplied-tenant guard (handoff decision 8). The owner requires this
  to be one self-contained commit whose only content is that deletion, so a future multi-user
  effort can revert it cleanly. Check that claim against the diff.
- `0dd7c0b` fixes the `ctx.id.name` fallback in `src/supervisor/supervisor.ts` (handoff decision 9)
  and adds `test/supervisor/naming.test.ts`.

For each commit answer: does it do what the decision asked, does it do anything the decision did
not ask, does it leave a dangling reference or a now-unreachable branch, is the new test asserting
the property or an implementation detail, and would you merge it. Name a file and line for every
finding. Rank findings: blocker, should-fix, nit.

Also check one specific risk in `0dd7c0b`: the throw runs in a Durable Object constructor. Say
whether any surviving call path reaches a Supervisor by raw id rather than by name, which would
now break. Search rather than assume.

## Part 2. Review a design decision the orchestrator has to make

Handoff decision 6 says to cut R2 from v0 and states that "module maps live in the existing,
tested Supervisor SQLite artifact store". The orchestrator has verified that this premise is
false: module maps are stored only in R2 today (`src/supervisor/artifacts/cache.ts`,
`ModuleMapCache`), and `src/supervisor/artifacts/index.ts` says in a comment that "Durable Object
SQLite stores no module source". There is no SQLite module-map store to move to. It has to be
written, which makes this commit a replacement rather than a deletion.

The orchestrator's proposed shape:

- Replace `ModuleMapCache` with a SQLite-backed store in the Supervisor, keyed by the labeled
  harness commit.
- One row per module (`harness_commit`, `name`, `source`), plus the entry module, rather than one
  row holding the whole encoded map, because a Durable Object SQLite row has a size limit and a
  single harness bundle can approach it.
- Build on submission, store, load on activate and on rollback. Rollback never rebuilds.
- Delete the corruption-recovery rebuild path, the cache age rule, and the double-build
  reproducibility gate, per decision 6.

Answer, with evidence from the repository and from current Cloudflare documentation where the
limit matters:

1. Is the per-module row the right shape, or is there a simpler one that still cannot exceed a row
   limit? State the actual documented Durable Object SQLite limits you found and cite where.
2. What breaks if the module map for a commit is partially written and the object then restarts?
   Name the smallest mechanism that makes the store either present or absent.
3. Which existing types and call sites does this touch, and is there a smaller change that
   satisfies decision 6? The orchestrator is biased to deletion, so say so if the honest answer is
   that R2 should be kept for v0 instead.
4. Does anything in the seven demo steps depend on the corruption-recovery path you are being
   asked to delete?

## Report

Write `/home/aditya/repos/cf-stumble/.audit/v0/review-sol-simplify.md` (gitignored, no commit),
then reply to your parent with `await agent_message.send(..., receiver_role='parent')` in under
500 words: merge or do-not-merge for each commit with the blockers, then your verdict on the
design decision and the shape you would build.
