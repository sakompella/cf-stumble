# Brand domain values with a type predicate, never an assertion

A raw string becomes a branded domain value such as `Sha` by passing a checking type predicate, following `parseSha` in `src/git/types.ts`, never by an `as` assertion. An assertion produces the branded type without checking it, so an unvalidated value enters the domain wearing a type that claims it was checked. That defeats the brand's purpose.

The lint gate enforces this rather than review: `typescript/no-unsafe-type-assertion` fires as an error through an enabled category, and three anti-slop rules cover the neighbouring ground: `require-safety-comment-for-type-assertion`, `no-chained-type-assertions`, and `no-widen-then-assert`. An assertion that must stay needs a `SAFETY:` comment stating the invariant already checked.
