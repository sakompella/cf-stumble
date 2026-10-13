# Use Effect inside the immutable host

> **Review:** Agent-only

The immutable host composes asynchronous work and recoverable failures with Effect 4. The host is
the Worker, Cloudflare Access verification, the owner routes, the model route, the Supervisor, the
Workspace Host, and the GitHub code. An operation that can fail in an expected way fails with a
tagged error in its Effect error channel, and the code that knows what the failure means handles it
by its tag. This replaced better-result and ADR-0035, which is deleted (Git keeps it). The owner
asked for the port on 2026-10-12.

The host moves to Effect in complete caller groups. Each group's callers move with it, and the
better-result API it replaces is deleted in the same change. One call path uses one style from
end to end: no path converts a better-result `Result` into an Effect and back, and no subsystem
keeps a Promise API beside an Effect API for the same operation. Waves 1, 2 and 3 removed the last
better-result import, and the package is gone.

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
identity or a request's Durable Object stub, lives in a global layer.

**What stays outside Effect.**

- Pure decisions stay plain functions over plain values, as ADR-0036 requires.
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
  lifetime until the turn settles, fails, is cancelled, or reaches its deadline (ADR-0037). Its
  `start` runs the body's program with `runResponseBody` in `src/run-entry-point.ts`, and its
  `cancel` interrupts that program. The program's settlement runs uninterruptibly, so a cancel
  cannot stop a turn between its thread write and the lease release. Workers RPC calls a
  stream's `cancel` only when the stream next writes, so a turn body writes an empty line every
  2 s while the generation is quiet, and once settled it ends the turn's capability, which kills
  any command the generation still has running (`turn-cancel.test.ts`).
- Durable state and platform alarms stay authoritative across Durable Object eviction. A fiber or
  a finalizer does not replace them, because eviction runs neither.
- The mutable harness, vendored Pi, and vendored Computer do not use the host's Effect. A
  generation may choose its own runtime under ADR-0024, and the host's use of Effect adds no
  requirement or authority for a generation under ADR-0003. The module map built from
  `src/facet/generation-0` contains no Effect code.

**Imports and tests.** Code imports Effect by module path, such as `effect/Effect`, and oxlint
forbids the `effect` index. The index re-exports every module and keeps some unused ones in the
Worker bundle. The Vitest workers pool loads each module again in every test file's isolate, so
`vitest.config.ts` bundles each imported Effect module path once with esbuild and resolves imports
to that bundle. Measured with the Worker's `fetch` running through `runAtEntryPoint`
(`vitest run --maxWorkers=2 --testTimeout=20000` on a busy Mac):

| Effect import               | Full suite | One isolate's import |
| --------------------------- | ---------: | -------------------: |
| none (before the port)      |     71.2 s |                    - |
| the `effect` index          |    126.8 s |                1.3 s |
| `effect/Effect`             |     87.1 s |               0.36 s |
| `effect/Effect`, prebundled |     67.5 s |                23 ms |

**Versions.** `effect` is pinned at exactly 4.0.0, because Foldkit 0.168.0 declares exact peers on
`effect` 4.0.0 and `@effect/platform-browser` 4.0.0 (ADR-0046). The three move together.

**Cost.** Running the Worker's `fetch` through `runAtEntryPoint` raised the upload from 744.70 KiB
(gzip 164.95 KiB) to 805.53 KiB (gzip 178.56 KiB). The Effect spike measured about 30 KiB gzip for
the runtime, errors, services, and layers, and about 45 KiB more for any use of `Schema`, so later
groups use `Schema` only where it parses untrusted input. `tools/bundle-budgets.test.ts` holds the
upload within 600 KiB gzip (ADR-0046, "Budgets").

**Alternatives.** Keeping better-result for results and adding Effect only for concurrency would
leave two systems for composing failures. Publishing Effect RPC or schema envelopes across Workers
RPC would change contracts that callers depend on, with no product need. Neither is adopted.
