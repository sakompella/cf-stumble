# Parse untrusted input at the boundary, without a schema library

Narrow untrusted input once, by hand, where it enters the program; the rest of the code works with typed domain values. Do not add a schema library. Adding one late would mean rewriting stable, tested parsers under a deadline, which adds more risk than it removes. A schema library puts a validator in front of an unknown boundary; the `unknown` remains.

## Consequences

Applying this rule to the existing codebase found 136 lint violations, 98 from this issue. Restructuring removed 93 of those 98 instead of loosening a rule. Four exceptions remain and are individually justified: three named boundary parsers and one overload required by isomorphic-git's `FsClient`.
