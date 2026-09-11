# Let size ceilings measure content and spacing own grouping

> **Review:** Agent-only

`anti-slop/require-readable-spacing` requires blank lines between declarations and logical
statement groups. Configure `eslint/max-lines` and `eslint/max-lines-per-function` to skip blank
lines while keeping their limits at 300 and 50. Keep comments in both budgets.

Against commit `541a484`, the spacing fix inserted 2,325 blank lines in 261 files. Counting those
required lines produced 15 file diagnostics and 12 function diagnostics across 23 paths, although
none gained executable code, types, tests, or comments. With blank lines skipped, the affected
files contain 242 to 274 counted lines and the affected functions contain 39 to 48. All remain
inside the existing limits.

Six independent readers reviewed all 2,325 insertions. They objected to 78, or 3.4 percent. Every
objection was a compact guard chain, a one-call-and-return switch case, or top-level constants that
a comment already groups. No reader found a comment separated from its subject, a split data
literal, or a general reason to reject the change. The rule has no options (`schema: []`), so a
softer layout would require a local fork of the verbatim vendored plugin.

The project accepts that measured local cost and adds no spacing suppression. A required disable
comment with a reason would be louder than the blank line it removed, repeated suppressions would
cost more lines than they save, and a local plugin fork would cost more to maintain than the 3.4
percent. Splitting the modules would add interfaces, imports, or test setup without hiding
complexity. The size rules therefore measure content, while the spacing rule owns vertical
grouping. This does not skip comments: prose is content a reader must understand.

The tightest repository-wide values that pass this snapshot are 275 and 48. This change does not
adopt them. Tightening the budgets is a separate decision, and 275/48 would leave the largest file
and function almost no headroom during a release.

A physical file may now exceed 300 lines because of required spacing. Split a module only when its
content crosses the budget or an architectural review finds a real seam with better locality or a
deeper interface.

Every size directive in the tree was audited by deleting it and running the gate. Nine exist, eight
of them load-bearing. Three file-level `max-lines` exceptions remain, on `tools/vendor-pi.mts` at
752 counted lines, `src/supervisor/supervisor.ts` at 307, and `src/workspace/project/exec-operation.ts`
at 332. Five `max-lines-per-function` exceptions remain on test functions, in
`test/access-cookie.test.ts` at 143, `test/access.test.ts` at 91, `test/access-owner.test.ts` at 77,
`test/github/credential-surfaces.test.ts` at 53, and
`test/facet/generation-0/execution-env-loaded.test.ts` at 51. The ninth, on
`src/supervisor/projects/turn-run.ts`, suppressed nothing at `541a484` and is deleted here.
