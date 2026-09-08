You are an adversarial reviewer. Codex quota blocked you overnight; the work proceeded without you.
Your job now is to find what a full night of unsupervised implementation got WRONG.

Repo: /Users/aditya/repos/projects/cf-stumble (cwd). Do NOT modify tracked files.

## What happened
Seven tasks were merged to main overnight, each gated on `pnpm verify` plus an objective check plus a
written report. Main is `0161f91`, green at 113 test files / 797 tests (baseline 93/642).

```
d1f2412 T1a  clean-commit build correctness + regression proof
567d25e T5   finish/abandon require the admitting lease
c3e0d5a T2   ADR-0030 cleanup: no request ids, fingerprints, or journal
43e7ac8 T3a  one tenant workspace holds every repository
638890e T4   stream real model events instead of one buffered message
54b02e2 T7   Pi instructions, compaction, diff; legacy buffered path deleted
0161f91 T6a  connect GitHub repositories with a testable credential
```

## Read
1. `.audit/v0/MORNING-BRIEF.md` — the summary.
2. `.audit/v0/decision-log.md` — D1..D62, every dispatch decision and why.
3. `.audit/v0/evidence/E1..E13` — findings confirmed from source.
4. `.audit/v0/tasks/*.md` — the seven worker reports. These are CLAIMS.
5. `.audit/v0/review-opus-round1.md` — the round-1 review you were supposed to write.
6. `git log --oneline d6ff238..HEAD` and the diffs that matter.

## Attack surface
- **Verify the claims.** Each report asserts acceptance criteria hold. Spot-check the ones that would
  be easiest to fake or most costly if wrong. Name any that do not hold.
- **The merges.** Seven branches merged in sequence, one with a hand-resolved conflict in
  `test/supervisor/threads/fresh-thread.test.ts`. Did anything get silently dropped?
- **T7 deleted ~1470 lines** (the legacy buffered turn path) and T9 later deleted more. Is anything
  goal.md requires now unreachable? The reviewer's own round-1 objection B3 was that deleting that
  path removes the only diff-producing code; T7 answered it with `bash` + `git diff` and a policy
  line. Judge whether that actually satisfies goal criterion 4.
- **Scope creep and cut line.** `.audit/v0/goal.md` has an explicit cut line. Did any merged task
  cross it?
- **The still-open work.** T9 (the HTTP turn surface) stalled mid-flight; its partial work is on
  branch `work/T9`. T1b, T3b, T8, T6b, T10, T11, T12 are unstarted and mostly blocked on owner
  approval for paid probes. Is the remaining plan still right given what actually landed?
- **Anything the overnight run believed that is false.** Three times a check encoded an assumption
  rather than a requirement, and a worker's alternative was better. Look for the inverse: places
  where a worker's answer was accepted too easily.

## Output
Write `/tmp/cf-stumble-v0/review-sol-round2.md`:
1. Verdict on the merged state: SOUND / SOUND WITH FIXES / SOMETHING IS WRONG.
2. Any claim in a worker report that does not hold, with file:line evidence.
3. Anything lost in the merges.
4. Goal-criteria coverage of what actually landed, versus what the roadmap promised.
5. What the remaining plan should change, given the real merged state.
6. What you could not verify and why.
Be specific and blunt. Do not ask the caller questions.