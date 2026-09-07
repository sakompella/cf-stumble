# E10 — E1 is FIXED and independently proven (T1a)

Status: VERIFIED BY THE ROOT AGENT, by running the probe, not by reading the worker's report.
Closes E1. Delivers the local half of goal criterion 7.

## What I ran

Commit `4bdd6dc fix(build): make a labeled harness commit build from a clean checkout`
(8 files, +442/-21), in the T1a worktree:

1. `pnpm verify` -> green. 94 test files, 650 tests, 13.5 s.
2. `bash scripts/probe/clean-build.sh` -> exit 0.

## What the probe reports

```
Clean build of 4bdd6dca7f2bc938f6ad1db962a339974aaad772
Archive bytes: 5785600
Build 1: 13 seconds, module map 905270 bytes, build directory 491M, cold store 598M
Build 2: 13 seconds, module map 905270 bytes, build directory 491M, cold store 598M
Module map sha256 (build 1): 387ed749d810edbabdea95e3078d4f5e3714fbb8007cbe7b989ee4b903b8da00
Module map sha256 (build 2): 387ed749d810edbabdea95e3078d4f5e3714fbb8007cbe7b989ee4b903b8da00
Two clean builds produced identical module maps
```

Before this change the same operation failed with five
`Could not resolve "@cf-stumble/pi"` errors from a `git archive` checkout.

## Why this matters

- The Supervisor can now build a labeled harness commit from clean state. Goal criteria 7 and 8
  were unreachable before it.
- Byte-identical maps across two independent clean builds is the reproducibility assumption
  ADR-0034 rests on. It had never been tested from a clean checkout.
- The cold-store numbers — 13 s per build, 491M build directory, 598M cold store — are exactly the
  B2 Gap 3 data T1b needs to choose the cold-build timeout that T9 and T12 depend on. They are now
  measured rather than guessed.

## What this does NOT close

Goal criterion 7 says two clean **Computer** builds. This probe runs on the developer machine with
an isolated store. It is a fast pre-check, not the release proof. T1b owns the Computer half and is
blocked on Q7.

Also unproven until T1b: whether a fresh Computer container has pnpm, registry egress, permission to
run native install scripts (`koffi`/`cnoke`), and `git`. The 598M cold store is a warning sign for
container disk budget.
