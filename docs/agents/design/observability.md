# Operational log

cf-stumble writes structured events for steps an operator may need to explain later: a turn
that was admitted and how it ended, a provisioning step, a Workspace Host RPC, a generation control
request, a refusal at the boundary, a credential install, and a workspace reset. Each event is one
plain object passed to one `console` call, so Workers Logs indexes every field and a query can
filter on `event`, `outcome`, or a field present on that event instead of matching text. Use
`projectId` for turn and provisioning events, and `project` for clone, size-check, and disconnect
events. The Supervisor and the Workspace Host run in the `cf-stumble` Worker, so their events are in
its logs too.

## Writing an event

`src/diagnostics.ts` owns the logger:

- `logEvent(level, event, fields)` writes `{ event, level, ts, ...fields }`. `info` goes to
  `console.log`, `warn` to `console.warn`, and `error` to `console.error`.
- `timed(event, fields, run, classify)` runs one promise and logs its `outcome` and `durationMs`.
  A rejection is logged at `error` as `outcome: "threw"` with a `timeout` flag, then rethrown.
- `logRedactedCause(context, cause, knownToken?)` still writes the redacted text of a thrown cause.
  It applies the field patterns, including the Access JWT pattern, to the whole cause before it
  cuts the cause to 400 characters. `timed` logs no cause, because only the caller knows which secret the cause might echo. A catch
  block may call `logRedactedCause`; not every exception log uses it.

A field value is a string, a number, a boolean, or `null`. Fields carry ids, names, codes,
counts, byte sizes, and durations. The logger redacts every string field with `redactCredentials`
and an Access JWT pattern, then cuts it to 200 characters. This covers recognized patterns, not
all secrets or plain-text exception logs. A caller passes a code, never a prompt, a frame's
text, file contents, command text, command output, a header value, a cookie, a token, a device or
user code, or a GitHub login. A caller that must name a lease uses `turnTrace`, which keeps the
last 8 characters of the lease id; the whole id never leaves the Supervisor.

Choose the level by what the event means. Use `info` for the ordinary lifecycle, `warn` for a
degraded path that the system survived (a refusal, a stale exclusion, a nonzero exit), and `error`
for a fault the system caused or could not recover from. Events describe steps, not every frame,
chunk, or byte. `turn.first-frame` marks the first frame once. `workspace.rpc-waiting` can repeat
while one call is pending.

To add an event, name it `area.thing`, add it to the tables below, and test it with
`capturedEvents` and `named` from `test/log-capture.ts`.

## Querying

Stream live events with Wrangler. Each tail record has a `logs` array, and the first element of
each log's `message` is the event object:

```sh
pnpm exec wrangler tail cf-stumble --format json \
  | jq -c '.logs[]?.message[0] | objects | select(.event? // "" | startswith("turn."))'
```

For past events, open the Cloudflare dashboard, go to Workers & Pages, select `cf-stumble`, and
open Observability. In the query builder, filter on the `event` field (for example
`event = turn.settled`) and group by a field such as `ending` or `outcome`. Workers Logs keeps
events for a limited retention period, so export what an incident needs while it is still there.

Common questions and the events that answer them:

| Question                          | Events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Why did a turn fail?              | `turn.refused`, `turn.started`, and `turn.settled` for the project; then the `workspace.*` events in between.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Is a lease stuck or replaced?     | A `turn.admitted` whose `lease` has no later `turn.settled` or `turn.lease-abandoned`; `turn.lease-reclaimed` signals admission after a previous instance's lease.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Is the workspace wedged?          | `workspace.exclusion-wait` with `result: "stale"`, `workspace.exclusion-stale`, repeated `workspace.rpc-waiting`, slow or `threw` `workspace.rpc` and `workspace.provision-step`, and `workspace.backend.closed` (check `running`), `workspace.container.wake-requested`, `workspace.container.started`, `workspace.container.adopted`, `workspace.container.stop-requested`, `workspace.container.stopped` (check `reasonSource`), or Computer's own log line with `message = workspace.container.exited`.                                                                              |
| Which request held the workspace? | `route.settled` with a long `durationMs` or an `applicationOutcome` other than `ok`; then filter all events on its `requestId` (`requestId = <id>` in Observability, or `select(.requestId? == "<id>")` in `jq`): `workspace.rpc`, `workspace.rpc-waiting`, `workspace.command`, and `github-credential.status`. To find suspects, filter `event = route.settled` and group by `route` and `applicationOutcome`. Only the project list and the GitHub connection read carry a `requestId` to these events; other routes write only `route.settled` (see "Route events and request ids"). |
| Does the GitHub credential work?  | `github-credential.install` and `github-credential.ensure`, especially `outcome: "credential-rejected"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Why was a request refused?        | `access.refused`, `route.cross-origin-refused`, `turn.refused`, and `project.size-check`. Credential authorization and disconnect can also refuse a request; `project.disconnected` is not written for a refusal.                                                                                                                                                                                                                                                                                                                                                                        |

## Issues and traces

Cloudflare Issues and Workers traces are on for this Worker (`observability.issues` and `observability.traces` in `cloudflare.config.ts` and `wrangler.jsonc`). Both configurations must keep them on: a deployment from a configuration without `issues` turns Issues off.

**Find a request's trace.** Every request that writes `route.settled` runs inside a span named `owner-api.route`. The span has two attributes: `request.id`, the same value as `requestId` in the log events, and `http.route`, the route pattern. To follow one request, copy `requestId` from its `route.settled` event. In the Observability query builder, add the filter `request.id = <id>` (checked on production on 2026-10-02). It returns the `owner-api.route` span. That span's `traceId` returns the whole trace, including the Durable Object RPC and SQL spans. The span is a child of the platform's handler span, because the pinned `@cloudflare/workers-types` and the local workerd have no `tracing.getActiveSpan`, although current Cloudflare docs and the workerd main branch do. When a pinned version has it, move the attributes onto the handler span and drop the extra span. The fetch, binding, and Worker-to-Durable-Object spans for that request appear below it. A turn's span ends when the stream starts, like `phase: "headers"`, so later turn work can appear as children that outlive it. Requests that write no `route.settled` event have no such span.

**What Issues catches.** Issues records uncaught exceptions, failed invocations, 5xx responses, `console.error` output, and stack traces, and it groups them. `logEvent` writes events at level `error` with `console.error`, so a `route.settled` event at `error` appears in Issues. Today only two things reach Issues from `route.settled`: a fault, and a request that ran for at least 901 seconds. A client that left also logs at `error`, but only under the `enable_request_signal` compatibility flag, which this Worker does not set (see "Route events and request ids").

**What Issues misses.**

- It ignores `warn`. Degraded and refused responses are warnings by design.
- It misses cost that is not an error: work that is expensive and finishes normally, and requests that are slow but finish in under 901 seconds. Use `durationMs` in `route.settled` and the trace for those.
- A canceled invocation often never reaches the code that writes `route.settled`, so a client that left may produce no event at all. The platform's own invocation record still exists.

**Sampling and cost.** Every sampling rate is 1, so no request is dropped and the start and end events of a request stay together. Traces bill one event per span. A span is one event in the same quota as logs: 20 million events a month are included on Workers Paid, then $0.60 per million, with 7 days of retention. One cold start of the workspace produced about 12,600 spans, mostly `durable_object_storage_exec` from the workspace filesystem start, which costs about $0.008 at the over-quota rate. If the bill grows, lower `traces.headSamplingRate` first.

**Not configured.** Issues automations, such as alerts or webhooks, are account resources in the dashboard. This repository creates none.

**Test warning.** `pnpm test` prints "Unexpected fields found in observability field: issues" for `wrangler.test.jsonc`. The vitest plugin bundles Wrangler 4.126, which does not know the field yet. The warning is harmless, and the file must keep the field so that the drift test passes.

## Route events and request ids

Every owner API request that reaches the workspace gets a `requestId`, a fresh UUID that the Worker
makes with `crypto.randomUUID()` in `routeOwnerApiRequest`. No header, query, or body field can
supply it, so a client cannot forge or reuse one. Filter on it to find the events one request
caused. For the project list and the GitHub connection read, it is sent to the Supervisor and the
Workspace Host as an explicit argument of each call, not stored as shared state, so overlapping
requests keep separate ids. Other routes do not pass it on.

| Event           | Level                                                                                                                                                                                                             | Fields                                                                                                                                                                                                                                                            | Written when                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `route.settled` | info when `ok`; warn when `degraded` or `refused`; error when `fault`, when `durationMs` reached the workspace budget (901 s), or when the client left (only under `enable_request_signal`; a refusal stays warn) | `requestId`, `route` (a pattern), `method`, `status` (`null` if the handler threw), `applicationOutcome` (`ok`, `degraded`, `refused`, or `fault`), `durationMs`, `clientAborted` (`true` or `null`), `phase` (`headers`, `body`, or `null` if the handler threw) | The route's response was ready. It covers the project list, the GitHub connection, authorization start and complete, connect, disconnect, generation submission, workspace reset, and project turns. Other routes write nothing. |

- `applicationOutcome` follows the status (`refused` for 4xx, `fault` for 5xx). `degraded` is a 200
  that still reports a problem: today, a GitHub connection in `reconnect-required`.
- The level decides what Cloudflare Issues shows, because Issues records `error` events and ignores
  `warn`. A request is an `error` when it faulted, or when `durationMs` reached the workspace
  command budget plus its margin (901 seconds): it ran at least as long as one workspace call's
  budget, so it held the workspace. A request is also an `error` when the client left before the
  response was ready, except a refusal, but that branch fires only under `enable_request_signal`,
  which this Worker does not set, so it is dead today. A `degraded` or `refused` response that
  returned in time stays a warning: it tells the owner something, and it did not hold the
  workspace.
- `phase: "body"` means the response was complete. A turn's response is a stream, so its event has
  `phase: "headers"`. It says the stream started, not that the turn ended. `turn.settled` is the end
  of a turn.
- `clientAborted` is `true` when the runtime aborted the request signal and `null` otherwise. The
  runtime aborts that signal only under the `enable_request_signal` compatibility flag, and
  `wrangler.jsonc` does not set it, so `null` means unknown, not "the client stayed". Even with the
  flag, a client disconnect usually cancels the invocation, so `true` will be rare.
- Only the project list, the connection read, and the credential calls under them carry the id to
  the Supervisor and the Workspace Host. The other routes write `route.settled` with an id that
  appears on no other event.
- The Workers platform records a canceled invocation with its own `outcome` and wall time, and that
  record exists even when this code never reaches its log line. Treat `route.settled` as evidence
  that a request finished, not as a count of requests: a canceled invocation can leave no
  `route.settled` event. For the project list and the connection read, the events the Supervisor
  and the Workspace Host write for that request still carry its `requestId`.

## Turn events

The Supervisor writes these. Every one except `turn.refused` carries `projectId`, `lease` (the
lease id's last 8 characters), and `generation` (the label the turn was admitted against, or
`null`), so one filter on `lease` returns a single turn's history.

| Event                  | Level                                  | Fields                                                                                                                                                                                                                            | Written when                                                                                                                                                                   |
| ---------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `turn.refused`         | info for a bad request, otherwise warn | `projectId` (the client's string, or `null`), `code`                                                                                                                                                                              | `runProjectTurn` returns a refusal, before or after admission.                                                                                                                 |
| `turn.admitted`        | info                                   | common fields                                                                                                                                                                                                                     | The lease is taken.                                                                                                                                                            |
| `turn.provisioned`     | info, warn, or error                   | common, `target` (`harness` or `repository`), `outcome` (`ready`, a problem code, or `threw`), `durationMs`                                                                                                                       | The selected checkout was reconciled.                                                                                                                                          |
| `turn.mounted`         | info or warn                           | common, `outcome` (`mounted` or a mount problem code), `durationMs`                                                                                                                                                               | The admitted generation was mounted.                                                                                                                                           |
| `turn.started`         | info, warn, or error                   | common, `outcome` (`started`, a refusal reason, `timed-out`, or `threw`), `durationMs`                                                                                                                                            | The whole start finished or lost its race with the turn's bound.                                                                                                               |
| `turn.first-frame`     | info                                   | common, `sinceAdmitMs`                                                                                                                                                                                                            | The first frame reached the browser.                                                                                                                                           |
| `turn.settled`         | info, warn, or error                   | common, `ending` (the terminal frame kind), `code`, `saved`, `revision`, `messageCount` when the ending has them, `frames`, `textFrames`, `toolStartFrames`, `toolResultFrames`, `diffFrames`, `diffUnavailableFrames`, `totalMs` | The Supervisor wrote the terminal frame. `saved` and `cancelled` are info, `turn-failed` and `turn-rejected` warn, and `save-failed`, `stream-invalid`, and `timed-out` error. |
| `turn.lease-abandoned` | warn or error                          | common, `why` (`start-threw`, `start-timed-out`, a refusal reason, or `stream-failed`)                                                                                                                                            | A lease was given back before the turn settled.                                                                                                                                |
| `turn.lease-reclaimed` | warn                                   | common, `why: "previous-instance"`                                                                                                                                                                                                | A new admission reclaimed a previous instance's lease, rather than abandoning this turn (`src/supervisor/projects/turn-run.ts:214-225`).                                       |

## Workspace events

| Event                                | Level                                                                                                              | Fields                                                                                                                                                                                                                                   | Written by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.rpc`                      | info, warn, or error                                                                                               | `method` (`project`, `credential`, `reset`, `provision`, `build`, or `ensureManagedInstructions`), optional `step`, `outcome`, `durationMs`, optional `requestId`, optional `timeoutMs`                                                  | The Supervisor, around a Workspace Host call, including calls within provisioning. `step` can name project removal, credential actions, provisioning, or build steps; reset has no step. For project removal, `outcome` is `removed`, `failed`, or the Workspace Host's failure code, such as `workspace-sync-incomplete` (`src/workspace/provisioning.ts:130-144,258-270`).                                                                                                                                                                                          |
| `workspace.provision-step`           | info, warn, or error                                                                                               | `plan` (`project` or `harness`), `projectId` (project plans), `step`, `method` (`provision`, `build`, or `ensureManagedInstructions`), `outcome` (`ok`, a problem code, or `threw`), `exitCode` (a failed command), `durationMs`         | The Supervisor, for each provisioning step. Each step is one Workspace Host RPC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `workspace.exclusion-wait`           | info, or warn when stale                                                                                           | `waiter` (`provision` or `turn`), `result` (`settled`, `aborted`, or `stale`), `waitedMs`                                                                                                                                                | The Supervisor, after waiting on another provisioning plan in the same workspace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `workspace.exclusion-stale`          | warn                                                                                                               | `heldForMs`                                                                                                                                                                                                                              | The Supervisor forgot a plan older than its whole command budget. The Workspace Host may still be running it.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `workspace.command`                  | info, or warn on a nonzero exit                                                                                    | `command` (the planned step, for example `provision-project.clone`, `harness-build.install`, or `github-credential.install`), `exitCode`, `durationMs`, `requestId` (credential status only so far), `timeoutMs`                         | The Workspace Host, for each planned command that returns. A clone or removal whose durable copy is incomplete throws first and writes no event (see below).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `workspace.reset`                    | info or error                                                                                                      | `outcome` (`reset` or `threw`), `durationMs`                                                                                                                                                                                             | The Worker, around the owner's reset request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `workspace.reset-step`               | info or error                                                                                                      | `step` (`delete-all` or `restart-container`), `outcome` (`ok`, the container's launch outcome, or `threw`), `durationMs`                                                                                                                 | The Workspace Host, for each reset step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `workspace.rpc-waiting`              | warn                                                                                                               | `method`, optional `step`, `elapsedMs`, optional `requestId`, optional `timeoutMs`                                                                                                                                                       | Every 30 seconds while one Workspace Host RPC remains pending; settlement clears its timer (`src/diagnostics.ts:194-221`).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `workspace.clone`                    | info on `ok`, otherwise warn                                                                                       | `project`, `durationMs`, `sizeKb` (number or `null`), `outcome` (`ok`, `failed`, or `unavailable`; `unavailable` includes `workspace-sync-incomplete`)                                                                                   | The Workspace Host's project clone step. `sizeKb` comes from its `du -sk` marker, not the GitHub API (`src/workspace/provisioning.ts:147-175`).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `workspace.exec`                     | info                                                                                                               | `outcome`, `exitCode`, `durationMs`, `timeoutMs`, `endedBy`, `errorCode` (nullable where applicable)                                                                                                                                     | A project command settled or was refused. A refusal has `exitCode: null`, `durationMs: 0`, and an `errorCode`; this is not per output chunk (`src/workspace/project/target.ts:276-316`).                                                                                                                                                                                                                                                                                                                                                                              |
| `workspace.container.started`        | info                                                                                                               | `trigger`, `runningBefore` (`true`, `false`, or `null`), `launchSequence`, `outcome` (`launched` or `relaunched`, from Computer's return value), `runtimeId`, `startedAtMs`, `durationMs`                                                | Computer's `start` or `restart` returned after launching. A start was issued; boot is not observed. `startedAtMs` is when the call returned, and `durationMs` is how long the call took, not how long the container took to boot (`src/workspace/container-observer.ts`).                                                                                                                                                                                                                                                                                             |
| `workspace.container.adopted`        | info                                                                                                               | `trigger`, `runningBefore`, `launchSequence`, `outcome: "adopted"`, `runtimeId`, `startedAtMs: null`, `durationMs`                                                                                                                       | A connect found a running container with the requested launch record and kept it. Its start time is not known.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `workspace.container.wake-requested` | info                                                                                                               | `trigger` (`backend-connect`, `backend-recovery`, or `workspace-reset`), `runningBefore` (`true`, `false`, or `null`), `launchSequence`                                                                                                  | Just before a launch request: a backend connect that finds the container not running (or unreadable), or any restart. A backend connect over a running container waits for the result: if Computer relaunches it, the wake is written after the call with `runningBefore: true`, and if it adopts, no wake is written. `launchSequence` counts launch requests in this Workspace Host instance and restarts at 1 for a new instance.                                                                                                                                  |
| `workspace.container.stop-requested` | info                                                                                                               | `reasonCode: "workspace-reset"`                                                                                                                                                                                                          | The reset asked for a container restart. This is intent; it does not show that a stop happened (`src/workspace/host.ts:87`).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `workspace.container.stopped`        | info when the Host replaced the container or the exit was clean; error for an unexpected exit code; otherwise warn | `runtimeId`, `stoppedAtMs`, `runDurationMs` (`null` if the launch was adopted or not seen by this instance), `reasonCode`, `reasonSource` (`application-intent` or `unknown`), `exitCode`, `signal: null`, `expected` (`true` or `null`) | The platform's container `monitor()` settled, once per runtime that this Workspace Host instance saw launch or adopt. The Host arms it after a launch returns, so it cannot start a container. `application-intent` means a Host launch was replacing the container; any other exit is `unknown`, and the log never names inactivity as a cause. An instance that is evicted writes no stop (`src/workspace/container-observer.ts`).                                                                                                                                  |
| `workspace.backend.connected`        | info                                                                                                               | `runtimeId` (string or `null`)                                                                                                                                                                                                           | A backend connection completed. It does not show that a container launched (`src/workspace/host.ts:194-205`).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `workspace.backend.closed`           | warn                                                                                                               | `trigger` (`transport-closed` or `connect-failed`), `running` (`true`, `false`, or `null` when the status read failed), `reasonCode`, `exitCode`, `signal`, `statusReadOutcome` (`ok` or `failed`)                                       | A backend transport closed, or a connect attempt failed. The Workspace Host reads status once, and both the generation bump and these fields come from that read. `running: true` means the container was still up; an exit status shows an observed exit. Nothing here claims a stop. It always logs `warn`, including the close that a reset's restart causes. Read `workspace.container.stop-requested` and `workspace.container.stopped` to tell an intended stop from a fault (`src/workspace/host.ts:206-211,216-220`; `src/workspace/backend-sync-ignore.ts`). |

### What the container events do not show

- **Backend retries.** Computer's connect loop probes health, restarts the container once, and
  gives up with one error. It has no callback for these steps. A `wake-requested` event with
  `trigger: "backend-recovery"` marks the one restart, and `workspace.backend.closed` with
  `trigger: "connect-failed"` marks a connect that gave up. The probe count, delays, and
  remaining time are not logged.
- **The stop before a backend recovery restart.** A restart that the backend asks for writes
  `wake-requested` with `trigger: "backend-recovery"` but no `stop-requested`, because only a
  reset writes one. The old container's exit that follows is marked `application-intent` by
  `stopped`.
- **Stops the Host cannot see.** A stop is written only while the Workspace Host instance that
  saw the launch is alive. If that instance is evicted, its stop is lost, and a later connect
  that adopts the container writes `adopted` with no start time.
- **Extra Durable Object residency from the stop observer.** The platform documents that a
  pending `monitor()` call keeps the Durable Object from being evicted until the container exits
  or for up to 15 minutes, and that a later operation can extend its time in memory. The stop
  observer adds one such call per runtime. Computer already makes the same call just before a
  launch returns. The residency the extra call adds has not been measured, and it needs evidence
  from a staging deployment.
- **Why the platform stopped a container.** The monitor reports an exit, not a cause. The log
  writes `reasonSource: "unknown"` for any exit the Host did not cause.

### Container lifecycle names changed

Earlier logs used `workspace.container.stopped`, `workspace.container.exited`, and
`workspace.container.started` for other facts. The app wrote `stopped` on every backend transport
close, even with `running: true`, and on a failed status read with a guessed `running: false`. It
wrote `exited` on a close with an exit status. It wrote `started` when a backend connected. The
meaning of each name changed in three steps, so a query for an old name needs the date of the first
deploy that contains the matching commit:

1. Commit `71f03be` (the first deploy containing it) removed the app's close-derived
   `workspace.container.stopped` and `workspace.container.exited` events and moved a backend
   connection to `workspace.backend.connected`.
   - Use `workspace.backend.closed` for a transport close, and read `running` and `exitCode`.
   - Use `workspace.container.stop-requested` for a reset's intent to stop.
   - Computer still writes its own `message: workspace.container.exited`, which is a separate
     producer.
2. Commit `130f353` (the first deploy containing it) made `workspace.container.started` follow a
   launch that Computer reports, whether from a backend connect, a backend recovery restart, or a
   reset. It added `workspace.container.adopted` and `workspace.container.wake-requested`. Between
   `71f03be` and `130f353`, `started` was written only after a reset restart.
3. Commit `68f76f7` (the first deploy containing it) brought `workspace.container.stopped` back
   with a new meaning: the platform monitor saw the container exit. It is never written for a
   backend close. Between `71f03be` and `68f76f7`, no event claimed a stop.

### When a clone or removal does not reach the durable store

The Workspace Host runs the project clone step and project removal with `require-complete`
(`src/workspace/computer-operations.ts`, `src/workspace/host.ts`). The Workspace Host answers
`workspace-sync-incomplete` in two cases. In the first, Computer's post-command copy reports
`pending` or skipped entries. In the second, the command exited 0 but the durable store does not
show the result (`src/workspace/executor.ts`). The events differ by case and by caller:

- When the copy is pending or skipped entries, `runCommand` throws before `runLoggedCommand` logs,
  so no `workspace.command` event is written for that command. The Workspace Host writes a plain
  `logRedactedCause` line instead: `workspace.project-removal: sync-incomplete: ...` or
  `workspace.provision-project.clone: sync-incomplete: ...`. The text gives the copy status, the
  exit code, and the number of skipped entries, and not Computer's pull error.
- When the store check fails after exit 0, `workspace.command` shows `exitCode: 0`, and the Workspace
  Host writes no further line. Only the Supervisor's events below show the refusal.
- For removal, the Supervisor writes `workspace.rpc` with `method: "project"`, `step: "remove"`,
  `outcome: "workspace-sync-incomplete"` at `error`. It then writes `project.disconnected` with
  `workspace: "failed"` at `error`. The thread and catalog row are already gone.
- For a clone, the Supervisor writes `workspace.rpc` with `method: "provision"`, `step: "clone"`,
  `outcome: "workspace-sync-incomplete"` at `warn`. `workspace.clone` reports
  `outcome: "unavailable"`, and `workspace.provision-step` reports
  `provision-workspace-unavailable`. Connection then refuses with `provisioning-failed`, or the
  turn is refused before it starts.

To find these cases, query `workspace.rpc` for `outcome = "workspace-sync-incomplete"`.

A `failed` disconnect with this outcome means the container deleted the clone, but the durable
store may still hold it. The store is read once, right after the command, and nothing retries a
pending copy. Whether a clone that stays in the store comes back after the Workspace Host or its
container is evicted and replaced is unproven: no test or deployment has observed it either way.
A later connection of the same repository would reuse that clone. No test has run Computer, so
how often a copy is pending in production is unknown.

## Generation events

| Event                    | Level                                      | Fields                                                                                                                                             | Written when                                                                                                                                                        |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generation.control`     | info, or warn when rejected                | `command`, `principal`, `label`, `commit` (12 characters), `epochBefore`, `epochAfter`, `outcome` (the outcome kind or the problem code), `effect` | A submission, activation, or rollback was decided. Preparation also moves the epoch, so `epochBefore` of an activation is not the epoch of the previous activation. |
| `generation.preparation` | info when `ready`, otherwise warn or error | `label`, `source` (`submitted` or `prepared`), `outcome` (the startup check stage or a problem code), `effect`, `durationMs`                       | A startup check finished. The check's reason text is not logged; it is whatever the harness threw.                                                                  |
| `harness-build.step`     | info, warn, or error                       | `commit`, `step`, `outcome` (`ok`, a build problem code, or `threw`), `exitCode` (a failed step), `durationMs`                                     | The Supervisor ran one build step in the workspace.                                                                                                                 |
| `harness-build.output`   | info, warn, or error                       | `commit`, `outcome`, `durationMs`                                                                                                                  | The Supervisor read and checked the build's module map.                                                                                                             |

A failed build step logs only its name, exit code, and duration. It does not log what the command printed, because command output can contain file contents. The redacted tail of each stream (the last 2,000 UTF-16 code units, without splitting a surrogate pair, with credentials and Access JWTs removed before the cut) travels instead in the owner's submission response, at `preparation.problem.diagnostics` as `stdoutTail`, `stderrTail`, and `truncated`. Only the owner, behind Cloudflare Access, receives it. Nothing stores it, so a submission that is interrupted before it responds loses the tail. A thrown workspace call in a build step or the module map read goes through `logRedactedCause` (`src/supervisor/artifacts/builder.ts`).

## Boundary and credential events

| Event                           | Level                                                                                                                | Fields                                                                                                                                    | Written when                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `access.refused`                | info for no usable credential, warn for `not-owner`, error for `invalid-configuration` and `key-service-unavailable` | `reason`, `route`, `method`, `status`                                                                                                     | The Worker refused a request at Cloudflare Access verification.                                                                          |
| `route.cross-origin-refused`    | warn                                                                                                                 | `route`, `method`, `origin` (`missing`, `null`, or `foreign`)                                                                             | A state-changing owner API request came from another origin.                                                                             |
| `github-credential.ensure`      | info when connected, otherwise warn or error                                                                         | `before`, `fallbackConfigured`, `outcome`                                                                                                 | The Supervisor found the workspace's credential missing or rejected and tried the configured token. A working credential writes nothing. |
| `github-credential.install`     | info when connected, error for `credential-rejected`, otherwise warn                                                 | `source` (`configured-token` or `device-authorization`), `outcome`                                                                        | A token was installed into the workspace.                                                                                                |
| `github-credential.status`      | info when connected, otherwise warn; error when the read throws                                                      | optional `requestId`, `outcome` (`connected`, `missing`, `unusable`, `tooling-missing`, or `threw`), `durationMs`, `timeoutMs`, `timeout` | The Workspace Host timed one credential status read, which runs a container command. It never logs the login.                            |
| `github-authorization.start`    | info or warn                                                                                                         | `outcome` (`started` or `provider-unavailable`)                                                                                           | The device authorization started.                                                                                                        |
| `github-authorization.complete` | info or warn                                                                                                         | `outcome` (`authorized`, `pending`, or a problem code)                                                                                    | The owner's redemption was checked with GitHub.                                                                                          |

## Project events

| Event                  | Level                            | Fields                                                                                                                                                                                                                                                                      | Written when                                                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.size-check`   | info if allowed, otherwise warn  | `project`, `sizeKb`, `blobCount`, `blobBytes`, `truncated` (each `null` when unknown), `outcome` (`allowed`, `refused`, or `skipped`), `reason` (`within-limits`, `tree-truncated`, `too-many-files`, `working-tree-too-large`, `repository-too-large`, or `lookup-failed`) | The connect preflight checks GitHub metadata after a valid URL and id, before checking workspace credentials. `skipped` proceeds, while `refused` maps to `repository-too-large` (`src/supervisor/projects/project-connections.ts:64-87,239-304`).                                |
| `project.disconnected` | info on removal, otherwise error | `project`, `workspace` (`removed` or `failed`)                                                                                                                                                                                                                              | The Supervisor removed the thread and catalog row and attempted workspace cleanup. A refusal writes no event; failed cleanup does not restore the row. `failed` includes a removal the durable store does not confirm (`src/supervisor/projects/project-connections.ts:311-343`). |

`route` is a pattern from `src/routes/route-pattern.ts`, never the request path: a project route
reads `/api/projects/:projectId/turn`, an unknown API path reads `/api/unknown`, and a path the
active generation serves reads `relay`. A GitHub credential `outcome` is the connection state, or
the reconnect reason when the state is `reconnect-required`.

## Noise from the container

Between 2026-09-24 and 2026-09-28 the container logs held base64 dumps of source text. Container output does not pass through the Worker's redaction, so such a dump would be unredacted. Logs since the image roll on 2026-10-02 show none.

Nothing in this repository's own code prints file contents. The Worker code writes through `logEvent` and `logRedactedCause` (`src/diagnostics.ts`), plus one line for an unmapped project provider error (`src/workspace/project/provider.ts`) that prints `String(error)` without redaction; that is older behavior and prints an error, not file contents. The one patch to Computer's daemon, `containers/computerd-walk.patch`, adds two log lines: the list of ignored path segments at start, and a failed symlink write with its path and error. Neither prints content. Computer's Worker-side package in `vendor/` writes a `console.debug` line (`[pullOnce]`), structured container-backend warnings and errors, and the logs of its bundled `isomorphic-git`; none prints file contents.

The source of the dumps is unknown. The only other process writing to the container's stdout is `computerd`, built by `containers/computerd.Dockerfile` from the pinned upstream commit (`COMPUTER_COMMIT`) with the patch. Upstream's `packages/computerd/src/exec/runner.ts` spawns commands with stdio `pipe`, so a command's output cannot reach container stdout by itself. A dump would have to come from `computerd` printing an error or a rejection that carried source text. The dumps stopped on 2026-09-28, before the image roll on 2026-10-02, and their start on 2026-09-24 may only reflect log retention, so the roll is not shown to be the cause. If they come back, find the container log line first, then read the upstream code at `COMPUTER_COMMIT`.
