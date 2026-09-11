# Re-vendoring anti-slop

## What was vendored

`tools/oxlint/anti-slop/` now holds a verbatim copy of `src/` from
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10), which upstream labels version 0.1.2 plus
later fixes. The MIT `LICENSE` from the repository root is kept beside it, unchanged, and the
`require-readable-spacing` rule brings a second MIT license and provenance note for the code it
vendors from ESLint Stylistic (`vendor/eslint-stylistic/`).

The previous copy came from upstream `6d538555` (2026-08-18). That was determined rather than
assumed: every file of the old vendored copy was compared against the same path in each upstream
commit, and `6d538555` is the one commit where all 34 shared files match byte for byte with nothing
missing. **The project had made no local modification to the plugin, so there was nothing to
preserve and nothing to drop.** The one local decision, that oxlint.config.ts stays this project's
own file and does not import upstream's lint configuration, is unchanged.

## What changed upstream

`git diff --stat 6d538555 c44ef22 -- src` is 49 files, 3108 insertions and 342 deletions. Nothing
was renamed or removed, and the plugin entry point still calls `eslintCompatPlugin` from
`@oxlint/plugins` with `defineRule` and `createOnce` rules, so the registration in
`oxlint.config.ts` needed no change in form.

Three new generic rules:

| Rule                        | What it rejects                                                              |
| --------------------------- | ---------------------------------------------------------------------------- |
| `no-array-filter-map`       | Adjacent eager `filter`/`map` passes over the same array.                     |
| `no-reduce-accumulator-copy`| Copying the accumulator inside a reducer.                                     |
| `require-readable-spacing`  | Missing blank lines around declarations, comments and control flow. Autofixable. |

Four new opt-in Effect rules (`no-manual-effect-error-tag`, `no-manual-tag-comparison`,
`no-manual-tagged-construction`, `prefer-effect-match`) join `no-service-constructor-imports` in the
separate `anti-slop-effect` plugin, with a shared `effect/shared/tagged-values.ts`.

Changed semantics on rules this project already enforces:

- `no-known-value-widening` now also reports a value with a known type handed to a type guard, not
  only a widening assignment (upstream `f171955`). This is the one rule that started reporting here.
- `no-unknown-parameters` exempts a type-predicate subject and a parameter named `cause`, and shares
  its parameter analysis with the widening rule (`63d6966`, `f171955`).
- `no-object-parameters`, `no-unknown-returns`, `no-unknown-type-aliases` and
  `no-unsafe-dictionary-type` resolve type aliases through a new shared resolver that follows scoped
  and generic aliases (`298c993`), so an alias declared in a nested scope is now understood.
- `require-safety-comment-for-type-assertion` recognises a comment above an exported declaration and
  accepts configurable markers (`63d6966`, `f2a8e0b`).
- `no-runtime-typeof` and `no-shape-in-symbol-names` were relaxed for third-party and boundary
  conventions (`f2a8e0b`).
- `no-known-value-widening`, `no-module-mocking` and the `Reflect` helpers share one scope walk
  (`4fdfa66`); behaviour is unchanged.

Upstream also added rule tests that did not exist before, so the vendored copy now ships 24 test
files instead of 13. All 24 pass here, run the way upstream runs them:
`./node_modules/.bin/tsx tools/oxlint/anti-slop/rules/<rule>.test.ts`. They are not part of
`pnpm verify`, because `vitest` only collects `src/` and `test/`, and the vendored directory is
ignored by oxlint, oxfmt and `tsc`.

## Dependency versions

Upstream pins `@oxlint/plugins` and `oxlint` at exactly `1.78.0`. This project asks for `^1` and
resolves both to `1.80.0`, which is newer, matched to each other, and passes every vendored rule
test. **No version bump was needed and `package.json` is unchanged.**

## Rule status

Counts under "adoption" are from the original vendoring commit `8c397b3`. All eight rules it
ratcheted off were already cleared and set to `error` on `main` before this work started; the
premise that eight rules were still off was out of date. "After re-vendor" is the count the new
vendored version reports against that already-clean tree.

| Rule                                        | Adoption | On `main` | After re-vendor | Now       |
| ------------------------------------------- | -------: | --------: | --------------: | --------- |
| `no-array-filter-map` (new)                 |        — |         — |               0 | `error`   |
| `no-chained-type-assertions`                |        1 |         0 |               0 | `error`   |
| `no-conditional-empty-object-spread`        |        0 |         0 |               0 | `error`   |
| `no-known-value-widening`                   |        8 |         0 |               1 | `error`   |
| `no-module-mocking`                         |        0 |         0 |               0 | `error`   |
| `no-object-parameters`                      |        1 |         0 |               0 | `error`   |
| `no-reduce-accumulator-copy` (new)          |        — |         — |               0 | `error`   |
| `no-reflect-apply`                          |        0 |         0 |               0 | `error`   |
| `no-reflect-get`                            |        0 |         0 |               0 | `error`   |
| `no-runtime-typeof`                         |       40 |         0 |               0 | `error` with `allowInTypeGuards` |
| `no-shape-in-symbol-names`                  |        0 |         0 |               0 | `error`   |
| `no-unknown-parameters`                     |       58 |         0 |               0 | `error`   |
| `no-unknown-returns`                        |        4 |         0 |               0 | `error`   |
| `no-unknown-type-aliases`                   |        0 |         0 |               0 | `error`   |
| `no-unsafe-dictionary-type`                 |       22 |         0 |               0 | `error`   |
| `no-widen-then-assert`                      |        0 |         0 |               0 | `error`   |
| `require-readable-spacing` (new)            |        — |         — |            2322 | **off**   |
| `require-safety-comment-for-type-assertion` |        2 |         0 |               0 | `error`   |

Without `allowInTypeGuards`, `no-runtime-typeof` reports 13 sites; every one of them is inside a
type guard, which is the option's whole purpose and the decision this project already made.

## The one rule still off

`require-readable-spacing`: 2322 violations across 261 files.

The rule inserts blank lines and `oxlint --fix` clears all 2322 without touching any other token,
so the objection is not the effort. Running the fix in a scratch copy, then `oxfmt`, then the
linter again shows what it costs: 15 files go over `eslint(max-lines)` and 12 functions go over
`eslint(max-lines-per-function)`, and both are errors under `--max-warnings=0`. Adopting the rule
therefore means splitting 27 files, including `src/model-route.ts`, `src/workspace/project/target.ts`
and `src/supervisor/projects/github-connection.ts`. That is a repository-wide restructuring decided
by a whitespace policy, and the 261-file diff would conflict with every branch open for the version
0 release. Blank lines are also the formatter's business here, and `oxfmt` owns formatting.

The count and this reasoning are recorded in `oxlint.config.ts` next to the rule, so the rule is off
on the record and not by omission.

## The Effect rule group

The vendored copy ships the five `anti-slop-effect` rules, and `oxlint.config.ts` deliberately does
not register that plugin. This project uses better-result, not Effect (ADR-0035), and the rules do
not check for an Effect import before reporting: with the plugin registered, `prefer-effect-match`
reports a chained ternary in `test/workspace/project/fakes.ts` and asks for an Effect `Match` that
nothing in this repository can import, and `no-manual-tag-comparison` would reject any
`value._tag === "..."` comparison, which is how better-result tagged errors are read. Upstream
registers this group only in projects that depend on Effect. The five rule names and this reason are
listed in `oxlint.config.ts`.

## The 98-site question from the adoption run

The vendoring commit said the 98 `no-unknown-parameters` and `no-runtime-typeof` sites were one
architectural question. `main` had already answered it, and this work follows the same answer: an
untrusted value is proved once at the boundary that receives it, the parsers keep their runtime
checks behind `allowInTypeGuards` or a stated boundary disable, and the proved type travels inward.
Both fixes below apply that same answer instead of a new one.

## Code changed to satisfy a rule

`src/access/keys.ts`, `src/access/verification.ts`, `src/access/index.ts` — the one site the
re-vendored `no-known-value-widening` reports. `keyMatches` took a `JsonWebKey` and passed it back
through `isRecord` to read `kid`, because `JsonWebKey` in workers-types has no `kid` field. That
discarded the type the caller already had and re-checked at runtime what the JWKS parser had already
proved. `isPublicJwk` is the only place that decides a `kid` is a non-empty string, so that decision
now has a name, `AccessPublicKey`, exported from the parser. Keys travel from the parser to the
verifier as that type, `keyMatches` reads `key.kid`, and `hasMatchingKid` no longer needs a `keyId`
helper that re-derived it. The tests already described a signing key this way as
`JsonWebKey & { readonly kid: string }`.

`src/facet/artifact.ts`, `src/supervisor/artifacts/store.ts` — not required by a reported
violation, but the same fault the rules exist to catch. `MainHarnessArtifact.parse` declared a
`MainHarnessArtifactInput` parameter and then re-checked every field with `typeof`, behind six
`no-runtime-typeof` disables and two `typescript/no-unsafe-member-access` disables, none with a
reason. The declared type was a claim no caller could keep: the stored-artifact reader asserted
`JSON.parse(...) as MainHarnessArtifactInput` and its SAFETY comment said `parse` would validate the
value anyway. The parameter now says `unknown` and `isMainHarnessArtifactInput` is the one place that
turns a decoded map into the input type. A `typeof` check inside a type guard is what the guard is
for, so eight disables went away and the assertion in the reader went with them. The same malformed
maps still fail as `invalid-artifact`.

## Disables

No disable was added to silence a rule. One was added to state a boundary, and it replaced eight:

| Site                        | Disable                                                             | Reason |
| --------------------------- | ------------------------------------------------------------------- | ------ |
| `src/facet/artifact.ts:58`  | `anti-slop/no-unknown-parameters` on `MainHarnessArtifact.parse`     | A built or stored module map is decoded JSON, so its shape is proven here. This is the parse boundary. |

Three pre-existing anti-slop disables carried no reason at all. Each was checked by removing it and
re-running the linter; each is still needed, so each now states why on the same line:

| Site                                        | Disable                          | Live violations | Reason |
| ------------------------------------------- | -------------------------------- | --------------: | ------ |
| `src/workspace/project/protocol.ts`         | `no-unknown-parameters`          |               8 | This is the RPC contract itself: a Durable Object stub can be called with any value, so every argument is unproven until `ProjectRpcTarget` parses it. |
| `test/workspace/project/decoded-events.ts`  | `no-object-parameters`, `no-unknown-returns` | 1 + 1 | Test-side decoder for one exec frame: a frame is decoded JSON, so reading a property off it and returning it is an untrusted read the caller narrows. |
| `test/workspace/project/exec-frame.test.ts` | `no-runtime-typeof`              |               2 | The frames under test come back across the RPC boundary, so the file narrows them before it asserts on them. |

## Disables deleted

Every file-level anti-slop disable was audited the same way: strip all of them at once, run the
linter, and see which rule names still have something to suppress. Twelve did not.

| File                                       | Deleted                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `src/routes/owner-api.ts`                  | the whole line: `no-unknown-parameters`, `no-runtime-typeof`, `no-unsafe-dictionary-type`, `no-unknown-returns` |
| `src/routes/json.ts`                       | `no-unknown-parameters`, `no-runtime-typeof`                        |
| `src/access/index.ts`                      | `no-unknown-parameters`                                             |
| `src/access/keys.ts`                       | `no-runtime-typeof`                                                 |
| `src/access/verification.ts`               | `typescript/no-unsafe-return`                                       |
| `src/routes/generations.ts`                | `no-unknown-returns`                                                |
| `src/routes/projects.ts`                   | `no-unsafe-dictionary-type`                                         |
| `src/routes/turns.ts`                      | `no-unsafe-dictionary-type`                                         |
| `src/facet/generation-0/plain-values.ts`   | `no-unknown-parameters`                                             |
| `test/access.test.ts`                      | `no-unsafe-dictionary-type`                                         |
| `test/workspace/project/decoded-events.ts` | `no-unknown-parameters`                                             |

A stale name is worse than no rule at all, because it hides the day the rule starts firing again on
that file. No anti-slop rule is now disabled anywhere without a live violation and a stated reason.

## Commits

`pnpm verify` ran green before each one, on the exact tree that was committed.

| Commit    | What it does |
| --------- | ------------ |
| `1b2952b` | `chore: re-vendor dmmulroy/anti-slop at c44ef22` — the vendored files, all 18 generic rules registered, the two clean new rules enforced, `require-readable-spacing` off with its count, `no-known-value-widening` off with its count. |
| `880d6ef` | `lint: name the signing key the JWKS parser accepted` — the `AccessPublicKey` type; ratchets `no-known-value-widening` back to `error`. |
| `8151a83` | `lint: prove a stored module map instead of declaring it` — `MainHarnessArtifact.parse` takes `unknown` behind a type guard; removes eight disables and one assertion. |
| `930c682` | `lint: delete the disables that suppress nothing` — the twelve stale disable entries, and a reason for each of the three that had none. |

Branch `work/anti-slop-revendor` is pushed. It is not merged: the version 0 release is in progress
on `main` in another checkout, so the merge is that release's decision, not this branch's.
