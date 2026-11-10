# Use Effect inside the immutable host

> **Review:** Agent-only

The immutable host composes asynchronous work and recoverable failures with Effect 4. The host is
the Worker, the owner routes, the model route, the Supervisor, the Workspace Host, the GitHub
code, and the orb CLI that runs on the provider machine (`src/stumble-cli/orb`). An operation that can fail in an expected way fails with a
tagged error in its Effect error channel, and the code that knows what the failure means handles it
by its tag. One call path uses one style from end to end: no subsystem keeps a Promise API beside an
Effect API for the same operation.

**Boundaries stay plain.** Workers RPC copies a returned value and
drops its behavior, and it refuses application-defined classes. SQLite rows, module maps, and
values in a facet's environment outlive the isolate that wrote them. So Workers RPC results, HTTP
JSON, SQLite rows, module maps, and facet environments carry plain values with the stable codes
callers already match on. No Effect, `Exit`, `Cause`, `Result`, schema, or error class crosses one
of these boundaries. The adapter at each boundary builds the plain value explicitly, and it logs a
defect redacted, never serialized to the owner or to mutable code.

**One interpreter per entry point.** A native entry point, such as the Worker's `fetch`, a Durable
Object RPC method, or an alarm, runs its program once with `runAtEntryPoint` in
`src/run-entry-point.ts`. Its error channel is `never`, so the program must already have turned
every expected failure into the plain value the entry point returns. A defect rejects the Promise
with the thrown value, as an `async` function would. No request-scoped value, such as the owner's
identity or a request's Durable Object stub, lives in a global layer. An entry point that is handed
an `AbortSignal`, such as the orb provider's command, passes it to `runPromiseExit`'s `signal`
option. The code below it is interrupted and never reads the signal.

**What stays outside Effect.**

- Pure decisions stay plain functions over plain values, so decisions run in ordinary tests with no Durable Object.
- A `transactionSync` callback stays synchronous. Where it runs an Effect at all, it uses
  `Effect.runSync`, which throws `AsyncFiberError` if a step would suspend, so the transaction
  rolls back instead of committing part of its writes. A typed refusal decided before the first
  write is a value and does not roll back.
- Synchronous code that can fail, such as a store, a parser, or a smart constructor like
  `MainHarnessArtifact.parse`, returns a `Result` from `effect/Result` rather than an Effect. The
  Supervisor's stores and generation control work this way, so their transaction callbacks run no
  Effect at all. An asynchronous caller lifts such a value with `Effect.fromResult`. A SQL
  exception is not a `Result`: it still escapes the callback, and the transaction rolls back.
- A streamed response body outlives the program that returned its headers. The body owns its own
  lifetime until its stream ends or is cancelled. Its `start` runs the body's program with
  `runResponseBody` in `src/run-entry-point.ts`, and its `cancel` interrupts that program, as the
  model route's stream does (`src/model-route-turn.ts`). A body that only relays another
  `ReadableStream` is an Effect `Stream` converted with `Stream.toReadableStream`, which forks and
  interrupts its own fiber the same way (the Supervisor's events stream in
  `src/supervisor/conversations/serving.ts`).
- Durable state and platform alarms stay authoritative across Durable Object eviction. A fiber or
  a finalizer does not replace them, because eviction runs neither.
- The mutable harness, Pi Durable, and vendored Computer do not use the host's Effect. A
  generation may choose its own runtime under ADR-0024, and the host's use of Effect adds no
  requirement or authority for a generation under ADR-0003. The module map built from
  `src/facet/generation-1` contains no Effect code.

**State machines (2026-11-09).** Host code whose state is persisted and changes in more than one
step is written as a state machine. Its states are one closed union, defined with
`Schema.TaggedUnion`, so the same definition gives the type, the decoder for stored rows, the
constructors, and an exhaustive `match`. Each variant carries only the data that is valid in that
state. One pure transition function per entry point takes the decoded state and the input and
returns the next state and a list of commands, values of a `Data.TaggedEnum` union. The Durable
Object method reads, decides and writes in one `transactionSync`, then runs the commands, such as a
log, a history write, or a facet replacement, after the commit. A table keeps its columns and gains
at most a column, and a codec maps rows to the union, so an older Worker can still read the rows
after a rollback. A small machine that lives only in memory and holds live handles keeps one field
of a `Data.TaggedEnum` union in place of several booleans, with no events or commands. The
generation machine (`src/supervisor/generation-machine.ts`) and the conversation run machine
(`src/supervisor/conversations/run-machine.ts`) follow this shape.

**Imports and tests.** Code imports Effect by module path, such as `effect/Effect`, and oxlint
forbids the `effect` index. The index re-exports every module and keeps some unused ones in the
Worker bundle. The Vitest workers pool loads each module again in every test file's isolate, so
`vitest.config.ts` bundles each imported Effect module path once with esbuild and resolves imports
to that bundle. Importing the `effect` index in the Worker's `fetch` path nearly doubled the full
suite's time; the prebundled module path costs about 23 ms per isolate.

**Lint.** `oxlint.config.ts` enables four rules of the vendored `anti-slop-effect` plugin as errors for
`src/**`: `no-manual-effect-error-tag`, `no-manual-tag-comparison`, `no-manual-tagged-construction`,
and `prefer-effect-match`. Code builds a tagged value with its Schema or `Data.TaggedError` constructor,
such as the `src/orb-protocol.ts` frame and job constructors, and branches on it with `Match.tag` or
`Predicate.isTagged`. The rules are off for `src/facet/generation-1/**` and for the host files that
the generation-1 module map bundles, because those files stay free of Effect. The fifth rule,
`no-service-constructor-imports`, stays off: the host has no services, `Context`, or `Layer`.

**Alternatives.** Keeping better-result for results and adding Effect only for concurrency would
leave two systems for composing failures. Publishing Effect RPC or schema envelopes across Workers
RPC would change contracts that callers depend on, with no product need. Neither is adopted.
