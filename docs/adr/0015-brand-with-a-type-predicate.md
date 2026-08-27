# Brand domain values with a type predicate, never an assertion

A raw string becomes a branded domain value such as `Sha` by passing a type predicate that checks it, following the `parseSha` idiom in `src/git/types.ts`, and never by an `as` assertion. An assertion produces the branded type without performing the check, so an unvalidated value reaches the domain wearing a type that claims it was validated — which defeats the only thing the brand exists to do.

## Consequences

The lint rule that would enforce this mechanically, `typescript/no-unsafe-type-assertion`, is not enabled in `oxlint.config.ts`. Three anti-slop rules police neighbouring ground (`require-safety-comment-for-type-assertion`, `no-chained-type-assertions`, `no-widen-then-assert`), so the convention rests partly on review until that rule is turned on.
