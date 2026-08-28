# The facet writes plain JavaScript, not TypeScript

A facet building its successor emits JavaScript that Worker Loader can run directly, with no compile step. The alternative was letting it write TypeScript that imports the same libraries the current runtime uses, which reads better and matches how a human would work on this codebase.

The cost decided it. Compiling TypeScript inside the facet means the facet needs a real workspace with a module resolver and a bundler before it can produce a successor at all, so the first self-modification is blocked behind infrastructure that has nothing to do with self-modification. Emitting JavaScript makes the workspace an improvement rather than a prerequisite, and the point of the prototype is to find out whether a facet can improve itself, not to prove a build pipeline works.

## Consequences

The facet cannot use `better-result`, or any other dependency, in the code it writes for itself. Its successors handle failures with whatever plain JavaScript allows, which means the error-handling discipline the supervisor holds itself to does not extend to facet-authored code. That asymmetry is deliberate: the supervisor's correctness protects recovery, while a facet generation that mishandles an error fails validation and never goes live.

Generated code will be harder to read than the hand-written runtime, and reviewing a candidate means reading JavaScript with no types. Validation evidence carries more weight as a result, since the type checker no longer speaks for facet-authored code.

This is reversible. Adding a build step later turns the emitted artifact into a compilation output without changing the promotion path, because Worker Loader takes JavaScript either way. Revisit when the facet's own harness grows past what is comfortable to write untyped, which is a judgement about the generated code rather than a milestone.
