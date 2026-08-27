# Adopting better-result

A repository-wide audit of how cf-stumble represents failure today, a target model built on
`better-result`, and a ranked set of vertical slices for getting there. Slice 1 is implemented;
slices 2-8 are specified well enough to be executed without redoing this analysis.

## 1. Scope and repository facts

| Fact             | Value                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Production code  | `src/`, 65 files, 8,635 lines                                                                                                            |
| Tests            | `test/` plus `src/**/*.test.ts`, 37 files, 214 tests                                                                                     |
| Runtime          | workerd only, per ADR-0008. `vitest.config.ts` runs every test in the `@cloudflare/vitest-plugin` pool                                   |
| Package manager  | pnpm 11.18.0                                                                                                                             |
| Validation       | `pnpm verify` = `tsc --noEmit` (TypeScript 7, strict) then `oxfmt --check` then `oxlint --type-aware --max-warnings=0` then `vitest run` |
| Entry points     | `src/supervisor/worker.ts` (`fetch`, forwards to the `Supervisor` Durable Object), `src/index.ts` (type-only re-exports)                 |
| Dependency added | `better-result@3.0.1`, a runtime dependency                                                                                              |

### better-result works in workerd

This was checked first, because a dependency that cannot run in workerd invalidates the whole
adoption. Two independent pieces of evidence:

- **Static.** The published package ships one ESM file, `dist/index.mjs`, with `"sideEffects": false`.
  Searching it for `require(`, `node:` specifiers, `process.`, `Buffer`, and `__dirname` returns
  nothing, so there is no Node built-in to polyfill.
- **Executed.** A temporary probe test ran inside the workerd pool and exercised
  `TaggedError` construction, `instanceof Error`, the generated `.is` guard, `TaggedError.is`, the
  `.match()` instance method, standalone `matchError`, `Result.ok`/`isOk`/`isError`, `Result.try`,
  `Result.tryPromise`, `Result.gen` with `Result.await`, `panic`/`isPanic`, and a `Result.codec`
  serialize/deserialize round trip that rehydrated a tagged error. All four probe cases passed.
  The probe was scratch and is not committed; slice 1's tests are the standing evidence, and they
  run in the same pool.

Installing the dependency on its own left all 214 tests passing, so nothing regressed from the
import alone.

### API facts confirmed against the installed types

Read from `node_modules/.pnpm/better-result@3.0.1/.../dist/index.d.mts` rather than recalled:

- `TaggedError(tag)` returns a class to extend; the subclass declares its props as a type
  parameter. Instances get `_tag`, `toJSON()`, `.match()`, `[Symbol.iterator]` (so a tagged error
  is directly yieldable in `Result.gen`), and a static `.is` guard. `match` is a reserved property
  name and cannot be used as a payload field.
- `Err` exposes its payload as the `.error` **property**. There is no `unwrapError()` method — the
  probe's first attempt at one failed with `TypeError: roundTripped.unwrapError is not a function`.
  Narrow with `Result.isError(r)` and read `r.error`.
- `Result.try` takes either a bare thunk (erring as `UnhandledException`) or
  `{ try, catch }`, where `catch` maps the thrown value to a typed error.
- `codec.deserialize` returns a single flat `Result` whose error channel carries either the decoded
  domain error or `ResultDeserializationError`; it is not a `Result<Result<...>>`.

## 2. Search evidence and counts

Run against `src/` only; `test/` was read for intended behavior, not counted as production surface.

| Mechanism                                      | Command                               |   Count |
| ---------------------------------------------- | ------------------------------------- | ------: |
| `throw` statements                             | `rg '^\s*throw ' src`                 |     204 |
| `try`/`catch` pairs                            | `rg '^\s*try \{' src`                 |      54 |
| `Error` subclasses and error-shaped interfaces | `rg 'extends (Error\|TypeError)' src` |       8 |
| `assertNever` exhaustiveness guards            | `rg 'assertNever' src`                |      39 |
| `\| undefined` sentinel positions              | `rg '\| undefined' src`               |     163 |
| Hand-rolled `{ok:true}\|{ok:false}` unions     | `rg -l 'readonly ok: false' src`      | 6 files |
| `Promise.reject`                               | `rg 'Promise.reject' src`             |       0 |

The 8 error types: `InvalidRequestError`, `MissingResourceError`, `SafetyViolationError` (all
`src/supervisor/supervisor.ts`), `AgentMaterializationError`, `ModelSourceError`, `ReplaySchemaError`,
`ReplayAbort`, and `ObjectTooLargeError` (an interface plus a factory that `Object.assign`s a code
onto a plain `Error`).

## 3. Production-area coverage map

| Production area           | Entry points                                                      | Files | Failure mechanisms                                                                                                                                              | Boundaries                                                       | Unknowns                                    |
| ------------------------- | ----------------------------------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `src/supervisor/`         | `worker.ts#fetch`, `Supervisor.fetch`, 24 routes                  |     4 | 63 throw, 30 catch, 3 `Error` subclasses, `requestErrorResponse` `instanceof` chain mapping to 400/404/422/500, bare `Response` literals at 401/404/409/422/500 | HTTP in/out (untrusted), DO SQLite storage                       | None                                        |
| `src/tools/`              | `executePrimitive`                                                |     5 | 4 throw, 5 catch, 3 hand-rolled `ok` unions, `undefined` = missing file                                                                                         | Workspace interface (`readFile`/`writeFile`/`execute` may throw) | None                                        |
| `src/agent/`              | `loadAgent`, `materializeGeneration`, `AgentExecutor.executeTurn` |    12 | 23 throw, 8 catch, `AgentMaterializationError`, `ModelSourceError`, `TurnFailure` 7-variant union                                                               | Model source (`requestModel`), generation store                  | None                                        |
| `src/generation/`         | `buildGeneration`, `readGeneration`, `seedGenesis`, registry ops  |     8 | 37 throw, 1 catch, `undefined` sentinels in registry types                                                                                                      | Git object store                                                 | None                                        |
| `src/git/`                | `encodeObject`/`decodeObject`, `parseSha`                         |     7 | 40 throw, 2 catch, `parseSha` throws `TypeError`                                                                                                                | Git wire format (byte-level, untrusted on decode)                | None                                        |
| `src/replay/`             | `parseReplaySession`, `runReplay`                                 |     7 | 25 throw, 2 catch, `ReplaySchemaError`, `ReplayAbort` used as control flow                                                                                      | Replay session JSON (persisted, untrusted; ADR-0005 ratchet)     | None                                        |
| `src/validation/`         | `runGate`, `runPreflight`                                         |    10 | 9 throw, 5 catch, `PASS`/`FAIL`/`INCONCLUSIVE` status objects                                                                                                   | Consumes turn + replay outcomes                                  | None                                        |
| `src/storage/`            | `Store` implementations                                           |     4 | 2 throw, `ObjectTooLargeError` identified by a `code` string, `undefined` = absent object                                                                       | DO SQLite                                                        | None                                        |
| `src/pointer/`            | `activate`, conformance suite                                     |     3 | 2 throw, `undefined` sentinels                                                                                                                                  | Pointer store                                                    | None                                        |
| `src/json.ts`             | `parseJsonValue`, `isJsonValue`                                   |     1 | 1 throw (`TypeError`)                                                                                                                                           | Untrusted `JSON.parse` output                                    | None                                        |
| `src/integration/turn.ts` | `runIntegrationTurn`                                              |     1 | 1 throw                                                                                                                                                         | None. Drives a superseded pointer model per `review-findings.md` | Superseded; excluded from every slice below |
| `src/index.ts`            | Type re-exports                                                   |     1 | None                                                                                                                                                            | None                                                             | None                                        |

## 4. Failure catalog

| ID  | Failure and trigger                                                                                                     | Source sites                                                   | Current path                                                         | Proposed disposition                                                                       | User mapping                           |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| F1  | Workspace path rejected: `empty`, `absolute`, `nul-byte`, `backslash`, `path-traversal`, `dot-segment`, `empty-segment` | `pathError`, `src/tools/types.ts:21`                           | `{ok:false, reason}` union, or `TypeError` from `parseWorkspacePath` | Recoverable, `InvalidWorkspacePathError` carrying `path` + `reason`                        | Preflight FAIL, agent-visible          |
| F2  | Path validator disagrees with its own predicate                                                                         | `src/tools/types.ts:58`                                        | `throw new Error`                                                    | **Defect**, `panic`                                                                        | Never surfaces                         |
| F3  | Workspace `readFile`/`writeFile`/`execute` throws                                                                       | 5 catches, `src/tools/primitives.ts`                           | caught, flattened to `{kind:"workspace-error", detail}`              | Recoverable, `WorkspaceOperationError` with `operation` + `cause`                          | Preflight INCONCLUSIVE (harness fault) |
| F4  | File absent                                                                                                             | `undefined` from `readFile`, 2 sites                           | `{kind:"file-not-found"}`                                            | Recoverable, `WorkspaceFileNotFoundError`                                                  | Preflight FAIL                         |
| F5  | File is binary when text required                                                                                       | 2 sites, `src/tools/primitives.ts`                             | `{kind:"binary-file"}`                                               | Recoverable, `BinaryFileError`                                                             | Preflight FAIL                         |
| F6  | Edit search text empty / no match / ambiguous                                                                           | `prepareEdit`, `src/tools/edit.ts:31-41`                       | `EditMatchError` union                                               | Recoverable, 3 tagged errors                                                               | Preflight FAIL                         |
| F7  | Counted edit match vanished                                                                                             | `src/tools/edit.ts:45`                                         | `throw new Error`                                                    | **Defect**, `panic`                                                                        | Never surfaces                         |
| F8  | Bash command exceeded its deadline                                                                                      | `src/tools/primitives.ts:255`                                  | `{kind:"timeout"}` with partial output                               | Recoverable, `CommandTimeoutError` keeping `stdout`/`stderr`                               | Preflight INCONCLUSIVE                 |
| F9  | Bash timeout option not a positive safe integer                                                                         | `src/tools/primitives.ts:228`                                  | `{kind:"invalid-timeout"}`                                           | Recoverable, `InvalidCommandTimeoutError`                                                  | Preflight INCONCLUSIVE                 |
| F10 | Primitive failure reached the replay recorder                                                                           | `toReplayResult`, `src/agent/runtime/loop.ts:262`              | `throw new TypeError`                                                | **Defect**, `panic`; the type should also make it unrepresentable                          | Never surfaces                         |
| F11 | Model source exhausted or errored                                                                                       | `src/agent/runtime/model-errors.ts`                            | `ModelSourceError` with a `kind` field                               | Recoverable, 2 tagged errors                                                               | Preflight INCONCLUSIVE                 |
| F12 | Tool call malformed / unknown tool / step budget exceeded                                                               | `src/agent/runtime/loop.ts`, `protocol.ts`                     | `TurnFailure` variants                                               | Recoverable, 3 tagged errors                                                               | Preflight FAIL                         |
| F13 | Transcript snapshot failed                                                                                              | `safeSnapshot`, `src/agent/runtime/transcript.ts`              | `{kind:"transcript-error", detail}`                                  | Recoverable, `TranscriptSnapshotError`                                                     | Preflight INCONCLUSIVE                 |
| F14 | Required agent module missing / invalid / unsupported                                                                   | `src/agent/runtime/definition.ts`, 6 throws                    | `AgentMaterializationError` with a `kind` field + `path`             | Recoverable, 3 tagged errors carrying `path`                                               | HTTP 422                               |
| F15 | Replay session JSON malformed, ~25 distinct conditions                                                                  | `src/replay/schema-parser.ts`, `schema.ts`                     | `ReplaySchemaError` with a `path`                                    | Recoverable, `ReplaySchemaError` as a tagged error keeping `path` + `condition`            | HTTP 400                               |
| F16 | Value is not JSON                                                                                                       | `src/json.ts:56`                                               | `throw new TypeError`                                                | Recoverable, `NotJsonValueError`                                                           | HTTP 400                               |
| F17 | String is not a SHA-1 object id                                                                                         | `parseSha`, `src/git/types.ts:24`                              | `throw new TypeError`                                                | Recoverable at untrusted boundaries; defect when re-parsing a value the store wrote        | HTTP 400                               |
| F18 | Git object bytes malformed, ~40 conditions                                                                              | `src/git/codec.ts`, `commit.ts`, `tree.ts`, `binary.ts`        | `throw`                                                              | Recoverable, `GitObjectDecodeError` with `objectType` + `condition`                        | HTTP 500 (store corruption)            |
| F19 | Generation record / row malformed                                                                                       | `src/generation/read.ts`, `build.ts`, `registry.ts`, 37 throws | `throw`                                                              | Split: untrusted request input recoverable, stored-row corruption a defect                 | HTTP 400 or 500                        |
| F20 | Object exceeds the storage size limit                                                                                   | `src/storage/do-sqlite.ts`                                     | `ObjectTooLargeError` matched by `code` string                       | Recoverable, `ObjectTooLargeError` as a tagged error                                       | HTTP 413                               |
| F21 | Request invalid (~20 conditions)                                                                                        | `src/supervisor/supervisor.ts:1744-2026`                       | `throw new InvalidRequestError`                                      | Recoverable, `InvalidRequestError` as a tagged error                                       | HTTP 400                               |
| F22 | Resource not found                                                                                                      | `MissingResourceError`                                         | `throw`                                                              | Recoverable tagged error                                                                   | HTTP 404                               |
| F23 | Safety violation: `not-live` or `quarantined`                                                                           | `SafetyViolationError`                                         | `throw` with a `kind` field                                          | Recoverable, 2 tagged errors                                                               | HTTP 422                               |
| F24 | Any other exception inside a route                                                                                      | 30 catches, `requestErrorResponse` fallthrough                 | 500 with `error.message` on the wire                                 | **Defect**; should become `panic` reaching one telemetry boundary, with a generic 500 body | HTTP 500, generic                      |
| F25 | Exhaustiveness guard reached                                                                                            | 39 `assertNever` calls                                         | `throw new Error`                                                    | **Defect**, `panic`                                                                        | Never surfaces                         |
| F26 | Replay aborted                                                                                                          | `ReplayAbort`, `src/replay/abort.ts`                           | thrown and caught as control flow                                    | Not an error. Model as an outcome variant, not a `TaggedError`                             | Not user-facing                        |

### Headline findings

**Three classes already carry a variant tag, which is a `TaggedError` written by hand.**
`AgentMaterializationError.kind` has three variants, `ModelSourceError.kind` two, and
`SafetyViolationError.kind` two. Each one pays for a class hierarchy and gets no exhaustiveness
checking in return: nothing forces a `switch` over `kind` to stay complete, because the compiler
sees a class, not a union. `TaggedError` gives the same data plus a `.match()` that fails to
compile when a variant is added.

**The 500 fallthrough puts internal messages on the wire.** `requestErrorResponse`
(`src/supervisor/supervisor.ts:2103`) ends with
`{ kind: "internal", message: error instanceof Error ? error.message : error }` at status 500. Any
unanticipated throw inside a route — including invariant messages like
`"promotion transaction did not produce a result"` (line 748) — is serialized to the caller. The
route's `catch` cannot tell a recoverable failure from a defect, because both arrive as `Error`.

**`supervisor.ts` is long partly because failure handling is duplicated 30 times.** Each route is
`try { ... } catch (error: unknown) { return requestErrorResponse(error instanceof Error ? error : String(error)); }`.
That is the same six tokens of ceremony per route with no type-level connection between what a
route can fail with and what statuses it can return. The file-wide
`oxlint-disable eslint/max-lines, eslint/max-lines-per-function, eslint/max-classes-per-file` at
line 2 is the visible cost. Three of the four disabled rules are about size, and
`max-classes-per-file` exists only because the three error classes live in the routing file.

**The boundary parsers are disciplined; the interior is not.** Request parsing at
`supervisor.ts:1744-2026` genuinely does convert every untrusted input into `InvalidRequestError`,
so an invalid SHA in a request body becomes a 400 and not a 500. That part of ADR-0016 is holding.
The inconsistency is inward of it: `src/tools/` returns unions, `src/validation/` returns status
objects, `src/git/` and `src/generation/` throw, and `src/agent/` does all three.

**`src/tools/` has already converged on the target shape by hand.** `WorkspacePathValidation`,
`EditDecision`, and `PrimitiveResult` are three separately-invented `Result` types with three
different field names for the payload (`path`, `content`, `error`). They cost a real bug surface:
`validateWorkspacePath` has to re-run its own predicate and throw if it disagrees
(`src/tools/types.ts:58`) purely to satisfy ADR-0015's no-assertion rule.

## 5. End-to-end propagation paths

**Primitive failure to preflight verdict** (slice 1's path, in full):

1. `pathError` / `prepareEdit` / a `Workspace` method throwing, or `readFile` returning `undefined`
2. `readPrimitive` / `writePrimitive` / `editPrimitive` / `bashPrimitive` wrap it as `{ok:false, kind, error}`
3. `executePrimitive` (`src/tools/primitives.ts:276`) dispatches and returns it
4. `executeLiveTool` (`src/agent/runtime/live-turn.ts:116`) converts it into
   `TurnFailure{kind:"primitive-failure", call, error}`
5. `TurnResult{status:"failed"}` reaches `AgentExecutor.executeTurn`'s caller
6. `failedTurn` (`src/validation/preflight-results.ts:165`) switches on `failure.kind`, then
   `isHarnessPrimitiveError` classifies the primitive error as harness fault (INCONCLUSIVE) or
   candidate fault (FAIL), and `primitiveFailureDetail` renders the message
7. The `PreflightCheck` becomes part of a preflight verdict; the supervisor serializes it

On the success side, step 4 continues into `capturedToolResult` → `toReplayResult`
(`src/agent/runtime/loop.ts:260`), which throws if handed a failure — reachable only if step 4's
guard is removed, so it is a defect (F10).

**Request to HTTP response** (every supervisor route): untrusted `Request` → a `parse*` helper
throwing `InvalidRequestError` → route body throwing `MissingResourceError` /
`SafetyViolationError` / anything else → route `catch` → `requestErrorResponse` `instanceof` chain →
`Response.json` at 400/404/422/500.

## 6. Boundary and codec map

| Boundary                     | Direction | Trust                               | Crossing today                               | Does a `Result` envelope cross? | Codec decision                                                                                                                                                                                                                   |
| ---------------------------- | --------- | ----------------------------------- | -------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP into `Supervisor.fetch` | inbound   | untrusted                           | JSON bodies, URL path segments               | No                              | No codec. Parse into typed domain values at the boundary per ADR-0016; return `Result<T, InvalidRequestError>` from each parser                                                                                                  |
| HTTP out of the supervisor   | outbound  | public                              | `{ error: { kind, message } }` plus a status | No, and it must not start       | No codec. `Result` ends inside the route handler, which exhaustively matches its error union to `(status, public body)`. The existing wire shape is asserted by `test/supervisor/supervisor.workers.ts` and is a public contract |
| Replay session JSON          | both      | untrusted, persisted                | `ReplaySession` domain data                  | No                              | No codec. A replay session is domain data, not a `Result` envelope. ADR-0005 makes this format a compatibility ratchet, so its shape must not change                                                                             |
| DO SQLite                    | both      | trusted producer, corruptible store | git object bytes, registry rows              | No                              | No codec. Wrap read failures in tagged errors; treat a malformed row the supervisor itself wrote as a defect                                                                                                                     |
| `Workspace` interface        | outbound  | may throw                           | paths, content, commands                     | No                              | No codec. Wrap each method's throw in a tagged error at the narrow call site                                                                                                                                                     |
| Model source                 | outbound  | may throw / exhaust                 | requests and responses                       | No                              | No codec. `ModelSourceError` becomes two tagged errors                                                                                                                                                                           |

**`Result.codec` is deliberately not adopted anywhere.** No boundary in this repository transports a
`Result` envelope: the HTTP responses carry domain payloads with a status code, the replay JSON
carries domain data, and storage carries git objects. Introducing an envelope would change three
public contracts to gain machinery this codebase has no use for. This also keeps ADR-0016 intact —
`Result.codec` wants Standard Schema validators, which is a schema library arriving through the back
door. The hand-written parsers stay hand-written; they change only in returning `Result` instead of
throwing.

## 7. Target model

Every known recoverable failure becomes a `TaggedError` subclass carrying structured context, and
every fallible operation returns `Result<T, E>` with `E` a union of those errors, so exhaustive
`.match()` at each presentation boundary — the supervisor's route handlers and the preflight
verdict builder — is what turns a failure into a status code or a verdict. Violated invariants stop
being indistinguishable from recoverable failures and become `panic`, which reaches the outermost
boundary as a generic 500 instead of putting an internal message on the wire.

Consequences worth stating:

- **ADR-0015 is preserved and strengthened.** Branding still happens through a type predicate.
  `parseWorkspacePath` keeps calling `isWorkspacePath`; it returns `Result<WorkspacePath, E>`
  instead of throwing. No `as` assertion is introduced anywhere, so
  `typescript/no-unsafe-type-assertion` stays clean.
- **ADR-0016 is preserved.** `better-result` is an error-handling library with no validation
  vocabulary. Parsers remain hand-written, one per boundary, and still narrow `unknown` once at the
  edge. The only change is how a rejection travels.
- **`assertNever` becomes `panic`.** All 39 sites express the same thing — an impossible variant —
  and `panic` says so in the type system's own vocabulary. Deferred to a mechanical pass after the
  slices, since it touches every module.
- **`ReplayAbort` is not migrated.** An abort is a legitimate outcome, not a failure. It should
  become an outcome variant, which is a separate modelling change tracked in `review-findings.md`
  territory.

## 8. Message mappings

Internal messages live on the tagged error, with the domain identifiers needed to debug it in
structured fields. User-facing text is produced at the presentation boundary, of which there are
exactly two:

- **`failedTurn`** (`src/validation/preflight-results.ts`) maps a turn failure to
  `PASS`/`FAIL`/`INCONCLUSIVE` plus a detail string. The existing `isHarnessPrimitiveError` split is
  the real policy and must be preserved exactly: a harness fault is INCONCLUSIVE, because blaming
  a candidate for the harness's own failure would corrupt the ratchet.
- **`requestErrorResponse`** (`src/supervisor/supervisor.ts`) maps an error to a status and a public
  body. After slice 8 it takes a tagged error union and matches exhaustively; the generic 500 stops
  carrying `error.message`.

## 9. Ranked vertical migration slices

Ordered so that each slice's errors are already tagged before the slice that consumes them. The
supervisor comes last on purpose: it is the confluence of every other path, so migrating it first
would mean writing its `.match()` against types that seven later slices still change.

**Slice 1 — Primitive execution failures. Complete; see section 11.** From `pathRejection` and
`prepareEdit` through `executePrimitive` and `executeLiveTool` to the `failedTurn` presentation
boundary in `src/validation/preflight-results.ts`. Bounded and valuable: it is the one path already
shaped like the target, so the change is mostly deletion of hand-rolled machinery; it ends at a real
presentation boundary whose policy is worth protecting (harness fault becomes INCONCLUSIVE,
candidate fault becomes FAIL); it has five dedicated test files; and it touches neither
`supervisor.ts` nor the replay wire format. Files: `src/tools/types.ts`, `edit.ts`, `primitives.ts`,
`workspace.ts`, `src/agent/runtime/live-turn.ts`, `loop.ts`, `types.ts`,
`src/validation/preflight-results.ts`, `preflight-probes.ts`.

**Slice 2 — Turn failures (`src/agent/runtime/`).** Migrate the remaining five `TurnFailure`
variants (F11, F12, F13) and delete the union. `ModelSourceError`'s two `kind` values become
`ModelSourceExhaustedError` and `ModelSourceFailedError`; `malformed-tool-call`, `unknown-tool`, and
`step-budget-exceeded` become tagged errors; `safeSnapshot` returns
`Result<WorkspaceTree, TranscriptSnapshotError>`. Files: `model-errors.ts`, `loop.ts`, `protocol.ts`,
`live-turn.ts`, `transcript.ts`, `types.ts`, `live-source.ts`, `recorded-source.ts`. Boundary:
`failedTurn`, which slice 1 already leaves as an exhaustive `.match()` over primitive errors plus a
`switch` over the remaining variants — slice 2 collapses both into one `.match()`. Tests:
`test/agent/runtime.test.ts`, `test/validation/preflight.test.ts`. This is the natural next slice
because slice 1 stops exactly at its edge.

**Slice 3 — Agent materialization (F14).** `AgentMaterializationError`'s three `kind` values become
three tagged errors carrying `path`; `materializeGeneration` returns `Promise<Result<AgentDefinition, E>>`.
Files: `src/agent/runtime/definition.ts`, `src/agent/loader.ts`, and the supervisor routes that call
it. Boundary: HTTP 422. Tests: `test/facet/facet-spike.test.ts`, `test/supervisor/supervisor.workers.ts`.

**Slice 4 — Untrusted JSON and replay session parsing (F15, F16).** `parseJsonValue` returns
`Result<JsonValue, NotJsonValueError>`; `ReplaySchemaError` becomes a tagged error keeping its
`path`; `parseReplaySession` returns a `Result`. `Result.gen` earns its place here — the parser is a
long sequence of fallible field reads. Files: `src/json.ts`, `src/replay/schema-parser.ts`,
`schema.ts`, `json-readers.ts`. Boundary: HTTP 400, and the ADR-0005 ratchet — the JSON format must
not change, only the parser's return type. Tests: `test/replay/schema.test.ts`,
`test/replay/fixture.test.ts`, `test/generation/malformed.test.ts`.

**Slice 5 — Git object decoding (F17, F18).** Add `parseShaResult` returning
`Result<Sha, InvalidShaError>` and keep the throwing `parseSha` only for trusted internal
re-parsing, documented as a defect path. `decodeObject` and the commit/tree/binary readers return
`Result<GitObject, GitObjectDecodeError>`. Files: `src/git/types.ts`, `codec.ts`, `commit.ts`,
`tree.ts`, `binary.ts`. Boundary: 400 for request-supplied SHAs, 500 for store corruption. Tests:
`test/git/codec.test.ts`, `test/git/commit.test.ts`, `test/git/oracle.test.ts`.

**Slice 6 — Generation reads and registry rows (F19).** The 37 throws split two ways, and the split
is the work: a malformed value from a request is recoverable, a malformed row the supervisor wrote
itself is a defect and should `panic`. Files: `src/generation/read.ts`, `build.ts`, `registry.ts`,
`genesis.ts`, `lineage.ts`, `types.ts`. Depends on slices 4 and 5.

**Slice 7 — Storage (F20).** `ObjectTooLargeError` becomes a real `TaggedError`, deleting the
`Object.assign`-a-code-onto-an-Error factory and the `isObjectTooLargeError` string check. `Store`
methods that can fail return `Result`. Files: `src/storage/do-sqlite.ts`, `types.ts`, `memory.ts`,
`conformance.ts`. Boundary: HTTP 413. Note the conformance suite is shared by both `Store`
implementations, so both move together.

**Slice 8 — Supervisor transport (F21-F24).** With every inbound failure already tagged, replace
`requestErrorResponse`'s `instanceof` chain with one exhaustive `.match()` from error tag to
`(status, public body)`, and stop the generic 500 from serializing `error.message`. Move the three
error classes out of the routing file. Each route becomes a `Result` pipeline instead of
`try`/`catch`. Expect to remove `eslint/max-classes-per-file` from the line-2 disable block, and to
have a real shot at `max-lines-per-function`. Files: `src/supervisor/supervisor.ts`, `auth.ts`.
Tests: `test/supervisor/supervisor.workers.ts` (571 lines, the largest test file). Highest risk in
the repository; do it last and do it alone.

**Deferred, not a slice.** The 39 `assertNever` sites become `panic` in one mechanical pass once the
slices land. `src/integration/turn.ts` is excluded entirely: it drives a superseded pointer model per
`docs/agents/design/review-findings.md`, and migrating it would entrench that model.

## 10. Unknowns and decisions needed

- **F17's dual disposition.** `parseSha` is called both on request input (recoverable) and on values
  read back from storage (defect). Slice 5 must classify all 30-odd call sites individually; the
  audit did not do this per-site. This is the main place slice 5 could expand beyond its estimate.
- **F19's split.** Same shape of question across 37 throws in `src/generation/`, and the reason
  slice 6 is ranked after the slices it depends on rather than by value.
- **F26 `ReplayAbort`.** Whether abort becomes an outcome variant is a domain-model decision that
  wants an ADR, not an error-handling decision. Out of scope here.
- **`UnhandledException` fallbacks.** None are planned. Every `catch` in slice 1 has a known
  operational meaning. Later slices touching the model source may need one; record it here if so.

## 11. Migration progress and validation log

| Slice                            | Status                         |
| -------------------------------- | ------------------------------ |
| 1 - Primitive execution failures | **Complete**                   |
| 2 - Turn failures                | **Complete**                   |
| 3 - Agent materialization        | **Complete**                   |
| 5 - Git object decoding          | **Complete**                   |
| 7 - Storage                      | **Complete**                   |
| 4 - Untrusted JSON and replay    | **Complete**                   |
| 6 - Generation reads and rows    | Next. Specified in section 9   |
| 8 - Supervisor transport         | Last, and pairs with the split |

**Baseline before migration.** With `better-result@3.0.1` installed and no source change,
`pnpm verify` passed and all 214 tests across 37 files ran green in the workerd pool, so the
dependency alone regresses nothing.

**Slices 2, 3, and 5 ran in parallel** in separate worktrees, which the ranking in section 9 does
not anticipate. It was safe because their files are disjoint and because slice 5 keeps the throwing
`parseSha` for internally built hex, so nothing outside `src/git/` had to change with it. Slice 4
was deliberately held back: it changes `parseJsonValue`, which `src/agent/runtime/protocol.ts` calls,
and slice 2 owned that file. Slices 6 and 7 stay serial — slice 6 depends on 4 and 5, and slice 7
changes the `Store` interface, which ripples into eleven files including `supervisor.ts`.

After all three, `pnpm verify` is green with 291 tests across 43 files (269 workerd, 22 Node
property tests), up from 259.

### Findings for later slices, not fixed here

- **A malformed or unloadable candidate is scored `INCONCLUSIVE`, not `FAIL`.**
  `executeGeneration` (`src/supervisor/supervisor.ts:590`) receives a typed
  `AgentMaterializationError` from slice 3 and throws it, so `executeSafely` renders it as
  `INCONCLUSIVE`. A candidate whose own modules are malformed is a candidate defect;
  `INCONCLUSIVE` should mean the platform left us unable to tell. The current behaviour is pinned by
  `test/supervisor/supervisor.workers.ts:347`, so changing it is deliberate and has a test to
  update. Slice 8 owns the transport; the verdict policy itself belongs to the facet runtime work.
- **Slice 3's 422 for a non-UTF-8 module is unreachable today.** Modules arrive as JSON strings
  through `POST /generations`, and a JSON string cannot carry invalid UTF-8. The branch becomes
  reachable only when a facet submits raw candidate bytes, and that is when it needs a test.
- **`parseSha` still throws a `TypeError` rather than panicking**, because `parseShaField`
  (`supervisor.ts:1781`) catches it to build a 400. Slice 8 moves that caller, after which it can
  panic. Documented on the function.
- **`snapshotWorkspace` panics on a list-then-read race** (`src/agent/runtime/transcript.ts:20`).
  Correct against `InMemoryWorkspace`, wrong against a real filesystem where the agent's own `bash`
  can delete a file between the two calls.
- **`sqlitePanic` treats storage being unavailable and storage being corrupt as one failure**
  (`src/storage/do-sqlite.ts:42`, whose own comment says "unavailable or corrupt"). Corruption is a
  defect and should panic. Transient unavailability — overload, exceeded limits, an eviction race —
  is retryable, and panicking makes it permanent. That matters more here than in an ordinary
  service: ADR-0007 ranks keeping recovery reachable above everything else, so the supervisor
  becoming unrecoverable exactly when its storage is under stress is the wrong failure mode. This is
  not a regression, since these paths threw before, but slice 8 will build a `.match()` that maps
  `Panic` to an unrecoverable 500, and at that point the mislabel becomes behaviour. Splitting it
  needs a retry policy, which is a design decision rather than a refactor.
- **Panicking on a stored corpus session turns a replay-schema bump into a bricked supervisor.**
  Slice 4 made `readCorpusCases` (`src/supervisor/supervisor.ts:1468`) `unwrap` with a panic, which is
  right for corruption: `writeCorpus` validates every incoming session at `supervisor.ts:1881` and
  stores the re-serialized parsed value, so a stored session that fails to parse cannot have come
  from a request. But `REPLAY_SCHEMA_VERSION` is `1 as const` and the parser enforces that literal,
  so bumping it makes every previously stored corpus row unparseable and every read panic. The corpus
  is supervisor state and has no migration path — ADR-0013's lazy migration covers facet state only.
  That is not hypothetical for a system built to evolve itself, and it lands on the facet plan, whose
  manifest slice makes the observable-effect contract versioned, which _is_ a replay schema change.
  A corpus migration has to exist before anything bumps that version.
- **Both recoverable branches added so far are close to unreachable.** Slice 7's 413 needs a single
  object above `MAX_OBJECT_BYTES`, which is 10 GiB, against modules measured in kilobytes; slice 3's
  422 for non-UTF-8 content cannot be reached through the JSON API at all. The panic paths are the
  live ones. Worth knowing when judging how much the migration has actually changed at runtime
  rather than in the types.

### Slice 1 - Primitive execution failures (complete)

**Boundary.** From the failure sources in `src/tools/` - `pathRejection`'s seven reasons,
`prepareEdit`'s three match failures, a throwing `Workspace` method, an absent file, binary
content, a command deadline, an invalid timeout option - through `executePrimitive` and
`executeLiveTool` to the two places a primitive failure is consumed: `TurnFailure`'s
`primitive-failure` variant, and the `failedTurn` presentation boundary in
`src/validation/preflight-results.ts` that renders it as a `PreflightCheck`.

**What changed.**

- **New `src/tools/errors.ts`** declares nine `TaggedError` subclasses plus the per-primitive
  unions and `PrimitiveError`. The seven path rejections collapse into one error carrying a
  `rejection` field, because no consumer distinguishes them; the three edit failures stay separate,
  because each produces different user-facing wording and collapsing them would make `occurrences`
  optional and so admit an invalid state.
- **`src/tools/types.ts`**: `parseWorkspacePath` returns
  `Result<WorkspacePath, InvalidWorkspacePathError>`. `validateWorkspacePath` and
  `WorkspacePathValidation` are deleted - the `Result` is the validation, so there is no longer
  both a throwing and a non-throwing entry point to keep in step. `WorkspacePathError` is renamed
  `WorkspacePathRejection`, since it names a reason and no longer an error object.
- **`src/tools/edit.ts`**: `prepareEdit` returns `Result<string, EditMatchError>`; `EditDecision`
  is deleted.
- **`src/tools/primitives.ts`**: `executePrimitive` returns `Promise<PrimitiveResult>`, now an
  alias for `Result<PrimitiveSuccess, PrimitiveError>`. The `ok: true` flag is off every success
  type, and `Failure<K, E>`, `PrimitiveFailure`, `InvalidPathError`, `WorkspaceError`, `ReadError`,
  `WriteError`, `EditError`, and `BashError` are all deleted. The five `try`/`catch` blocks become
  one `workspaceCall` helper wrapping `Result.tryPromise`, and the duplicated read-then-check-
  undefined-then-check-binary sequence becomes one `readTextFile`. The file is 240 lines, down
  from 295, and the deleted type machinery is replaced by 170 lines of named errors.
- **`src/agent/runtime/`**: `live-turn.ts` narrows with `Result.isError`; `loop.ts` takes
  `PrimitiveSuccess`; `types.ts` carries `PrimitiveError`; `transcript.ts` reports the error's
  message instead of its old `kind`.
- **`src/validation/preflight-results.ts`**: `isHarnessPrimitiveError` and
  `primitiveFailureDetail` become exhaustive `.match()` calls. Adding a primitive error variant now
  fails to compile in both, which the old `switch` on a `kind` field could not do.
- **`src/tools/workspace.ts`** and `verifyTextFile` in `preflight-results.ts` take trusted setup
  input, so they `unwrap()` with a message; an invalid path there is a defect, not a condition to
  report.

**Deviations from the plan in section 9.**

1. **F2 became a `panic`, not a structural impossibility.** The audit predicted the
   validator-disagrees-with-predicate check could be deleted outright. It cannot: branding requires
   calling the type predicate in a narrowing position (ADR-0015 forbids an assertion), so the
   compiler cannot see that a path rejected by the predicate always has a reason. The check
   remains, as `panic` with a message naming both sides of the disagreement - which is the correct
   disposition rather than a workaround.
2. **`oxlint.config.ts` sets `eslint/max-classes-per-file` to `{ max: 12 }`.** Nine sibling error
   classes trip a default of 1. The alternatives were a file-level `oxlint-disable` (rejected) or
   nine one-class files (rejected: the taxonomy read together is the design). This is a repo-wide
   policy change and deserves review. It also removes the need for `max-classes-per-file` in the
   line-2 disable block of `supervisor.ts`, which slice 8 should drop; that block was left
   untouched here.
3. **`Result.map` was replaced with explicit `Result.isError` guards.** `unicorn/no-array-callback-reference`
   fires on `Result.map(result, fn)`, mistaking it for `Array.prototype.map`. The early-return form
   reads better next to the surrounding guards anyway, so no suppression was needed. Worth knowing
   before later slices reach for the static combinators.

**Test changes.** 214 pre-existing tests still pass; 21 were added, for 235 across 38 files.

- Rewritten in place, because the values changed shape: `test/tools/primitives.test.ts`,
  `edit.test.ts`, `bash.test.ts`, `path-safety.test.ts` assert `_tag` and context fields through
  `expectOk`/`expectErr` instead of `result.ok` and `error.kind`.
- Two assertions changed because a field was removed rather than renamed:
  `test/agent/runtime.test.ts:261` now expects
  `error: { _tag: "WorkspaceFileNotFoundError", path: "missing.txt" }` in place of
  `error: { kind: "file-not-found" }`, and `test/integration/vertical-path.test.ts:32` drops
  `ok: true` from a `WriteResult`, as does `test/integration/fixtures.ts`.
- Mechanical: `parseWorkspacePath(...)` becomes `parseWorkspacePath(...).unwrap()` at 14 test call
  sites, where throwing on an invalid literal is the intent.
- `test/validation/preflight.test.ts` is **unchanged**, including its INCONCLUSIVE assertion. The
  preflight detail strings are byte-identical, which is the evidence the harness-fault policy
  survived the migration.

New coverage: `test/validation/primitive-failure-mapping.test.ts` pins the harness-fault vs
candidate-fault verdict and the exact detail string for all nine variants, and asserts that every
variant appears in one of the two lists. `test/tools/path-safety.test.ts` covers all seven path
rejections, where it previously covered three. `test/tools/primitives.test.ts` asserts `cause` is
preserved as the original `Error` through `Result.tryPromise` rather than flattened to a string.
`test/tools/workspace.test.ts` asserts the constructor's invalid-fixture path raises `Panic`.
New shared helper: `test/support/result.ts`.

**Validation.** `pnpm verify` passes end to end: `tsc --noEmit` clean, `oxfmt --check` clean,
`oxlint --type-aware --max-warnings=0` clean, 235/235 tests green in workerd. No `oxlint-disable`
comment was added anywhere, and `supervisor.ts` was not touched.

**Next slice: 2 (turn failures).** It is the natural continuation - slice 1 stops exactly at the
`TurnFailure` seam, and slice 2 collapses the `switch` over the remaining variants and the
`.match()` over primitive errors into one exhaustive match at the same boundary.
