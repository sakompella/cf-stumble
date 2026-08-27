# Verification

A green suite matters only when it can fail for the defect it claims to catch. Each practice here has been checked against a real or introduced defect. `docs/agents/design/review-findings.md` covers the separate question of what these checks cannot prove.

## Mutation testing

A test that passes against correct behavior may still pass after the behavior breaks. To check that a test discriminates, break the guarded behavior and expect the suite to fail.

- **Git object codec.** Changing a tree entry mode to `040000` introduced a plausible one-digit encoding error. The nested-tree oracle test failed. That is why the independent oracle earns its place: it detects this class of codec error instead of agreeing with the codec's decoder.
- **Compare-and-swap store.** Yielding between the expected-value check and write created the race a Durable Object could expose. The CAS conformance test reported 16 winners instead of 1. It turns a race into a countable failure, so S9 can run it unchanged against Durable Object SQLite.
- **Bootstrap primitive-kind union.** Adding a fifth member failed at the `assertNever` exhaustiveness check with `TS2345`. The compiler enforces handling every member of the current union. It does not claim that four primitives are a permanent product constraint; four was the bootstrap scope (see `docs/agents/design/design-history.md`).

## Cross-implementation oracles

An encoder and decoder can share the same error and still round-trip. Check them against an implementation written independently.

The codec first used the `git` binary: it compared every object id with `git hash-object` and gave a codec-built store to `git log` and `git cat-file`. That oracle required subprocesses, which workerd cannot run, so the project moved to isomorphic-git. It is pure JavaScript, runs in workerd, and was written independently. A prototype compared byte-identical objects from both implementations before the move. The tree-mode mutation above was then rerun to confirm the new oracle still caught the defect.

## Shared storage conformance

`src/storage/conformance.ts` is parameterized by a store factory and runs against the in-memory store and Durable Object SQLite. Separate suites would let each implementation follow a different idea of the interface while both passed. One suite applies the same CAS assertion to either implementation.

A diff between the commit before the Durable Object store and the commit that added it confirmed that both stores use byte-identical `conformance.ts`, rather than separate tests that happen to look similar.

## Cold-clone checks

A checkout can pass because of stale `node_modules`, an untracked `.dev.vars`, or a local fixture. Delete derived state, reinstall from the lockfile with `rm -rf node_modules && pnpm install --frozen-lockfile`, then run the full gate.

This found a test secret in untracked `.dev.vars`. Its creator saw a passing suite; a fresh clone got an opaque 401. The fix moved the credential into tracked `miniflare.bindings` in `vitest.config.ts`, so the repository alone reproduces the test environment.

## Lint ratchet

Adding `dmmulroy/anti-slop` oxlint rules found 136 violations. Enabling all fifteen at once would have required a large change before the gate could pass, or would have disabled the rules until an unspecified future cleanup.

The project enabled a rule whenever the codebase was already clean. For a rule with violations, it recorded the count and left the rule disabled until the violations were fixed. The gate stayed green and no violation disappeared behind a broad suppression. Ninety-eight of the 136 findings were one question, hand-written JSON parsers versus a schema library; restructuring resolved 93 of those 98. All fifteen rules now run with four narrow, documented exceptions.

This also caught a merge regression: a conflict resolution restored two violations that an enforced rule had removed. The next lint run failed.

## Limits

Mutation testing checks one known bug class at a time; it cannot cover bugs nobody tried to introduce. Independent implementations can agree on a blind spot. The conformance suite checks that two stores meet one interface, not that the interface covers every needed behavior. A cold clone proves reproducibility from the repository, not code correctness.

These checks also say nothing about production authorization, Cloudflare account behavior beyond local workerd, or the maturity of `@cloudflare/computer`. `docs/agents/design/review-findings.md` keeps those gaps explicit.
