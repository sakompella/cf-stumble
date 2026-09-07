# E11 — The reproducibility proof survives the merges, and it shows the host/harness boundary is real

Status: VERIFIED BY THE ROOT AGENT on merged main. Regression check for goal criterion 7.

## What I ran

`bash scripts/probe/clean-build.sh` on main `d1f241264f5fdf73f2cdf23b00c1aaf17e590a02`
(T5 + T2 + T1a all merged):

```
Build 1: 13 seconds, module map 905270 bytes
Build 2: 13 seconds, module map 905270 bytes
sha256 (both): 387ed749d810edbabdea95e3078d4f5e3714fbb8007cbe7b989ee4b903b8da00
Two clean builds produced identical module maps
```

## The interesting part

That sha256 and byte count are IDENTICAL to the ones measured on T1a's own commit `4bdd6dc`, before
T2 and T5 were merged — even though T2 deleted `src/supervisor/control/journal.ts` and rewrote
generation control across 36 files, and T5 rewrote `src/supervisor/threads/`.

This is correct, not a stale artifact. The module map is built for the main-harness FACET
(`tools/build-generation-0.mts` over the generation-0 sources). The Supervisor is immutable host
code that runs in the Worker, not inside a facet. So a Supervisor-side change SHOULD leave the
harness artifact untouched.

It is worth recording because it is the first empirical demonstration of the boundary v0 exists to
prove: harness code is replaceable and identified by its own artifact, while host code changes
around it without disturbing that identity. ADR-0034's commit-keyed artifact identity behaves as
documented under a real, large host-side change.

## What it does not prove

Still local, still not Computer. Goal criterion 7 needs two clean COMPUTER builds; T1b owns that and
is blocked on Q7. A stable map across host changes is also not a claim that the map is stable across
HARNESS changes — it should NOT be, and no task has yet demonstrated a deliberately different
harness commit producing a different map. That is goal criterion 8's "second visibly different
harness commit", owned by T12a.
