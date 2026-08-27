# Verification

How this project knows a green test suite means something, rather than just having one. Every
technique here exists because "the tests pass" is a claim that can be true for the wrong reason —
a suite that can't fail proves nothing by passing — so each practice below is paired with a
concrete check that the suite _can_ fail, applied to a real defect or a deliberately introduced
one.

This document covers technique and instances. It does not repeat `docs/agents/design/review-findings.md`,
which is the separate, harder question of what a green suite does _not_ prove — read that
document for the boundaries of everything below.

## Mutation testing: prove the suite would catch the bug it claims to catch

Writing a test that exercises correct behavior tells you the code works today. It tells you
nothing about whether the test would notice if the code stopped working — a test that always
passes regardless of the implementation is worse than no test, because it looks like coverage.
The check used throughout this project is direct: deliberately break the thing the test is
supposed to guard, and confirm the suite goes red. If it doesn't, the test wasn't testing what it
looked like it was testing.

Three instances, each guarding a claim central to the architecture:

- **The git object codec.** Padding a tree entry's file mode to `040000` (a plausible one-digit
  encoding slip) was introduced deliberately, and the nested-tree oracle test failed as expected.
  This is the specific bug class the codec's independent oracle exists to catch, so confirming it
  actually catches this bug — not just agrees with itself — is what makes the oracle worth having
  rather than decorative.
- **The compare-and-swap store.** A store implementation was modified to yield between comparing
  the expected value and performing the write, which is exactly the race window a real
  Durable Object could expose under concurrent access. Running the CAS conformance test against
  the mutated store produced 16 winners instead of 1 — sixteen writers, all believing they'd won
  the compare-and-swap. That the conformance suite's CAS assertion turns a real race into a
  visible, countable failure — rather than an intermittent flake someone would shrug off — is the
  reason it's trusted enough for S9 to rerun it verbatim against real Durable Object SQLite.
- **The fixed action space.** Adding a fifth member to the primitive-kind union was attempted
  directly, to check whether the "only four primitives, ever" claim is enforced or merely
  documented. It failed the build at an `assertNever` exhaustiveness check (`TS2345`), not at
  runtime and not by convention. That means the four-primitive boundary is a compiler-enforced
  invariant: nobody can add a fifth action space without the build itself refusing, which is a
  materially stronger guarantee than a comment or a code-review norm.

## Cross-implementation oracles: correctness checked by someone else's code

A decoder that only ever gets checked against its own encoder can drift in a way that looks
consistent from the inside — encode-then-decode round-trips forever, even if both sides share the
same misunderstanding of the format. The fix is to check against an independent implementation
that wasn't written to agree with this one.

The git object codec used the real `git` binary this way at first: every encoded object's id was
checked against `git hash-object`, and a store built entirely by the codec was handed to `git
log` and `git cat-file` to read back. That caught real bugs and was a good oracle, with one fatal
property — it needs a subprocess, and workerd cannot run subprocesses, so the codec's correctness
was only ever being proven in a runtime the project doesn't deploy to. It was replaced with
isomorphic-git, which is pure JavaScript, runs inside workerd, and is still a genuinely
independent implementation written by different people with different assumptions — a
throwaway prototype confirmed both implementations produce byte-identical objects given identical
inputs before the swap was trusted, and the mode-padding mutation test above was rerun against the
new oracle to confirm the swap hadn't quietly weakened what it catches.

## The shared conformance suite: one definition, two implementations, no drift

`src/storage/conformance.ts` is written once, parameterized over a store factory, and run against
both the in-memory store and the real Durable Object SQLite store. The alternative — writing the
in-memory store's tests once and the DO store's tests separately — invites the two
implementations to quietly diverge: a behavior one store happens to have and the other doesn't
would show up as "our tests pass" on both sides, because each side would only ever be checked
against its own idea of correct. Running the identical assertions against both closes that gap:
the CAS mutation test above discriminates a torn write in _either_ implementation, because it's
the same test file running twice, not two similar-looking ones.

Verified directly by diffing `conformance.ts` between the commit that introduced the DO SQLite
store and the commit before it: the file used by both storage implementations is byte-identical,
not "conceptually the same tests, rewritten."

## The cold-clone check: a green suite in a stale checkout proves nothing about a fresh one

Tests passing in a working directory that has accumulated local state — an untracked `.dev.vars`,
a stray fixture, a `node_modules` from before a dependency changed — can pass for reasons that
have nothing to do with the code being correct. The check is to delete everything derivable and
reinstall from the lockfile: `rm -rf node_modules && pnpm install --frozen-lockfile`, then run the
full gate.

This caught a real defect. A test secret had been placed in `.dev.vars`, which `.gitignore`
excludes from version control, so the suite depending on it passed for whoever happened to have
created that file locally and failed with an opaque 401 for anyone starting from a clean clone —
including, mechanically, `main` itself once the merge landed. The fix moves the test credential
into `miniflare.bindings` inside `vitest.config.ts`, which is tracked, so the suite is
reproducible from nothing but the repository. The cold-clone check is what surfaces this class of
bug; without it, "passes on my machine" and "passes from the repository" are silently different
claims.

## The lint ratchet: adopting a stricter rule set without ever letting the gate go red

Vendoring `dmmulroy/anti-slop`'s oxlint rules against the existing codebase produced 136
violations on first run. Turning all fifteen rules on at once would have meant either fixing 136
sites before the gate could pass again — a large, high-risk change landed all at once — or
disabling the whole rule set until that work finished, which tends to mean it never finishes.

The ratchet used instead: enable each rule immediately if the codebase was already clean against
it, and for rules with violations, record the exact count and leave the rule off until the
violations are addressed, rather than silently tolerating them or looping the whole thing behind
one disable comment. The gate never goes red at any point in this process, and nothing is
tolerated invisibly — a recorded count is a commitment with a number attached, not a suppression.
Ninety-eight of the 136 violations turned out to be one architectural question (hand-written JSON
parsers versus a schema library); 93 of those 98 were resolved by genuine restructuring rather
than by loosening the rule, and all fifteen rules are now enforced with four narrow, individually
justified exceptions. The same ratchet discipline is what caught a merge regression immediately:
resolving a conflict between two parallel agents' work accidentally reintroduced two sites a
now-enforced rule had already fixed, and the lint gate — already strict — failed on the very next
run rather than the regression sitting undetected.

## What this does not cover

Mutation testing proves a specific test discriminates a specific class of bug; it says nothing
about bug classes nobody thought to mutate toward. Cross-implementation oracles prove agreement
between two implementations, not correctness against a specification neither one encodes — if
both git and isomorphic-git shared some other blind spot, this technique would not surface it. The
conformance suite proves the two storage implementations satisfy the same interface; it does not
by itself prove that interface is complete. The cold-clone check proves reproducibility from the
repository, not correctness of what's in it. None of these techniques address production
authorization, real Cloudflare account behavior versus local workerd, or the maturity of
`@cloudflare/computer` as a dependency — those are exactly the gaps `docs/agents/design/review-findings.md`
exists to hold open rather than let a green suite quietly paper over.
