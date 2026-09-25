# Operational log

cf-stumble writes one structured event for each step an operator may need to explain later: a turn
that was admitted and how it ended, a provisioning step, a Workspace Host RPC, a generation control
request, a refusal at the boundary, a credential install, and a workspace reset. Each event is one
plain object passed to one `console` call, so Workers Logs indexes every field and a query can
filter on `event`, `projectId`, `outcome`, or any other field instead of matching text. The
Supervisor and the Workspace Host run in the `cf-stumble` Worker, so their events are in its logs
too.

## Writing an event

`src/diagnostics.ts` owns the logger:

- `logEvent(level, event, fields)` writes `{ event, level, ts, ...fields }`. `info` goes to
  `console.log`, `warn` to `console.warn`, and `error` to `console.error`.
- `timed(event, fields, run, classify)` runs one promise and logs its `outcome` and `durationMs`.
  A rejection is logged at `error` as `outcome: "threw"` with a `timeout` flag, then rethrown.
- `logRedactedCause(context, cause, knownToken?)` still writes the redacted text of a thrown cause.
  `timed` logs no cause, because only the caller knows which secret the cause might echo; a catch
  block that discards a cause calls `logRedactedCause` as well.

A field value is a string, a number, a boolean, or `null`. Fields carry ids, names, codes,
counts, byte sizes, and durations. The logger redacts every string field with `redactCredentials`
and an Access JWT pattern, and cuts it to 200 characters, so a code built from tool output cannot
carry a token. That is the last line of defence: a caller passes a code, never a prompt, a frame's
text, file contents, command text, command output, a header value, a cookie, a token, a device or
user code, or a GitHub login. A caller that must name a lease uses `turnTrace`, which keeps the
last 8 characters of the lease id; the whole id never leaves the Supervisor.

Choose the level by what the event means. Use `info` for the ordinary lifecycle, `warn` for a
degraded path that the system survived (a refusal, a stale exclusion, a nonzero exit), and `error`
for a fault the system caused or could not recover from. An event describes a step, so no event is
written per frame, per chunk, or per byte.

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

| Question                         | Events                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Why did a turn fail?             | `turn.refused`, `turn.started`, `turn.settled` for the project; then the `workspace.*` events in between.                                                  |
| Is a lease stuck?                | A `turn.admitted` whose `lease` has no later `turn.settled` or `turn.lease-abandoned`.                                                                     |
| Is the workspace wedged?         | `workspace.exclusion-wait` with `result: "stale"`, `workspace.exclusion-stale`, and slow or `threw` `workspace.rpc` and `workspace.provision-step` events. |
| Does the GitHub credential work? | `github-credential.install` and `github-credential.ensure`, especially `outcome: "credential-rejected"`.                                                   |
| Why was a request refused?       | `access.refused` and `route.cross-origin-refused`.                                                                                                         |

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

## Workspace events

| Event                       | Level                           | Fields                                                                                                                                                                                                                           | Written by                                                                                                    |
| --------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `workspace.rpc`             | info, warn, or error            | `method` (`project` or `credential`), `step` (credential only), `outcome`, `durationMs`                                                                                                                                          | The Supervisor, around a Workspace Host call that is not a provisioning step.                                 |
| `workspace.provision-step`  | info, warn, or error            | `plan` (`project` or `harness`), `projectId` (project plans), `step`, `method` (`provision`, `build`, or `ensureManagedInstructions`), `outcome` (`ok`, a problem code, or `threw`), `exitCode` (a failed command), `durationMs` | The Supervisor, for each provisioning step. Each step is one Workspace Host RPC.                              |
| `workspace.exclusion-wait`  | info, or warn when stale        | `waiter` (`provision` or `turn`), `result` (`settled`, `aborted`, or `stale`), `waitedMs`                                                                                                                                        | The Supervisor, after waiting on another provisioning plan in the same workspace.                             |
| `workspace.exclusion-stale` | warn                            | `heldForMs`                                                                                                                                                                                                                      | The Supervisor forgot a plan older than its whole command budget. The Workspace Host may still be running it. |
| `workspace.command`         | info, or warn on a nonzero exit | `command` (the planned step, for example `provision-project.clone`, `harness-build.install`, or `github-credential.install`), `exitCode`, `durationMs`                                                                           | The Workspace Host, for each planned command.                                                                 |
| `workspace.reset`           | info or error                   | `outcome` (`reset` or `threw`), `durationMs`                                                                                                                                                                                     | The Worker, around the owner's reset request.                                                                 |
| `workspace.reset-step`      | info or error                   | `step` (`delete-all` or `restart-container`), `outcome` (`ok`, the container's launch outcome, or `threw`), `durationMs`                                                                                                         | The Workspace Host, for each reset step.                                                                      |

## Generation events

| Event                    | Level                                      | Fields                                                                                                                                             | Written when                                                                                                                                                        |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generation.control`     | info, or warn when rejected                | `command`, `principal`, `label`, `commit` (12 characters), `epochBefore`, `epochAfter`, `outcome` (the outcome kind or the problem code), `effect` | A submission, activation, or rollback was decided. Preparation also moves the epoch, so `epochBefore` of an activation is not the epoch of the previous activation. |
| `generation.preparation` | info when `ready`, otherwise warn or error | `label`, `source` (`submitted` or `prepared`), `outcome` (the startup check stage or a problem code), `effect`, `durationMs`                       | A startup check finished. The check's reason text is not logged; it is whatever the harness threw.                                                                  |
| `harness-build.step`     | info, warn, or error                       | `commit`, `step`, `outcome` (`ok`, a build problem code, or `threw`), `exitCode` (a failed step), `durationMs`                                     | The Supervisor ran one build step in the workspace.                                                                                                                 |
| `harness-build.output`   | info, warn, or error                       | `commit`, `outcome`, `durationMs`                                                                                                                  | The Supervisor read and checked the build's module map.                                                                                                             |

A failed build step also writes the redacted tail of its output as a text line, because that tail
is the only record of why the build failed.

## Boundary and credential events

| Event                           | Level                                                                                                                | Fields                                                             | Written when                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `access.refused`                | info for no usable credential, warn for `not-owner`, error for `invalid-configuration` and `key-service-unavailable` | `reason`, `route`, `method`, `status`                              | The Worker refused a request at Cloudflare Access verification.                                                                          |
| `route.cross-origin-refused`    | warn                                                                                                                 | `route`, `method`, `origin` (`missing`, `null`, or `foreign`)      | A state-changing owner API request came from another origin.                                                                             |
| `github-credential.ensure`      | info when connected, otherwise warn or error                                                                         | `before`, `fallbackConfigured`, `outcome`                          | The Supervisor found the workspace's credential missing or rejected and tried the configured token. A working credential writes nothing. |
| `github-credential.install`     | info when connected, error for `credential-rejected`, otherwise warn                                                 | `source` (`configured-token` or `device-authorization`), `outcome` | A token was installed into the workspace.                                                                                                |
| `github-authorization.start`    | info or warn                                                                                                         | `outcome` (`started` or `provider-unavailable`)                    | The device authorization started.                                                                                                        |
| `github-authorization.complete` | info or warn                                                                                                         | `outcome` (`authorized`, `pending`, or a problem code)             | The owner's redemption was checked with GitHub.                                                                                          |

`route` is a pattern from `src/routes/route-pattern.ts`, never the request path: a project route
reads `/api/projects/:projectId/turn`, an unknown API path reads `/api/unknown`, and a path the
active generation serves reads `relay`. A GitHub credential `outcome` is the connection state, or
the reconnect reason when the state is `reconnect-required`.
