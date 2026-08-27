# Brand domain values with a type predicate, never an assertion

A raw string becomes a branded domain value such as `Sha` by passing a type predicate that checks it, following the `parseSha` idiom in `src/git/types.ts`, and never by an `as` assertion. An assertion produces the branded type without performing the check, so an unvalidated value reaches the domain wearing a type that claims it was validated — which defeats the only thing the brand exists to do.

The lint gate enforces this rather than review: `typescript/no-unsafe-type-assertion` fires as an error through an enabled category, and three anti-slop rules cover the neighbouring ground — `require-safety-comment-for-type-assertion`, `no-chained-type-assertions`, and `no-widen-then-assert`. An assertion that genuinely has to stay needs a `SAFETY:` comment stating the invariant that was already checked.
