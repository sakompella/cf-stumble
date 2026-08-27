# Parse untrusted input at the boundary, without a schema library

Untrusted input is narrowed once, by hand, at the point it enters the program, and the rest of the code works with typed domain values; no schema library is taken on. Adopting one late would have meant rewriting stable, tested parsers under a deadline, which adds more risk than it removes, and a schema library hides an unknown boundary behind a validator rather than removing it — the `unknown` is still there, now with a dependency in front of it.

## Consequences

Applying this against the existing codebase produced 136 lint violations, 98 of which were this one question. Restructuring removed 93 of those 98 rather than loosening a rule. Four exceptions remain and are individually justified: three named boundary parsers, plus one overload required by isomorphic-git's `FsClient`.
