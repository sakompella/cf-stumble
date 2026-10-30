# Operational log

cf-stumble writes a few structured events: one per turn end, one per idle stop, one per container
start and reset, and the ChatGPT and GitHub credential faults. Each event is one plain object passed
to one `console` call, so Workers Logs indexes every field and a query filters on `event` or
`outcome` instead of matching text. The Supervisor and the Workspace Host run in the `cf-stumble`
Worker, so their events are in its logs. Everything else is in the platform's invocation records,
Workers traces, and Issues.

## Writing an event

`src/diagnostics.ts` owns the logger:

- `logEvent(level, event, fields)` writes `{ event, level, ts, ...fields }`. `info` goes to
  `console.log`, `warn` to `console.warn`, and `error` to `console.error`. A field value is a
  string, a number, a boolean, or `null`. Every string field is redacted with `redactCredentials`
  and a JWT pattern, then cut to 200 characters.
- `logRedactedCause(context, cause, knownToken?)` writes the redacted text of a thrown cause, cut
  to 400 characters. A catch block that may see a secret in the cause uses it.

The redaction covers recognized patterns, not all secrets. A caller passes ids, codes, counts, and
durations, never a prompt, a frame's text, file contents, command text or output, a header, a
cookie, a token, a device or user code, or a GitHub login. A turn names its lease by `turnTrace`,
the last 8 characters of the lease id.

Use `info` for the ordinary lifecycle, `warn` for a degraded path the system survived, and `error`
for a fault it caused or could not recover from. Add an event only when an operator could not answer
the question from the platform's records; name it `area.thing` and add it to the table below.

## Events

| Event                           | Level                                                                | Fields                                                                                                                                                                        | Written when                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.settled`                  | info, warn, or error                                                 | `projectId`, `lease`, `generation`, `ending` (the terminal frame kind), `code`, `saved`, `revision`, `messageCount` when the ending has them, frame counts by kind, `totalMs` | The Supervisor wrote the terminal frame. `saved` and `cancelled` are info, `turn-failed` and `turn-rejected` warn, and `save-failed`, `stream-invalid`, and `timed-out` error (`src/supervisor/projects/turn-log.ts`).                 |
| `turn.frame-dropped`            | warn                                                                 | `projectId`, `lease`, `generation`, `reason` (`oversized-frame` or `unknown-kind`)                                                                                            | A progress frame was left out of the browser's stream. Once per reason per turn.                                                                                                                                                       |
| `turn.lease-abandoned`          | warn or error                                                        | `projectId`, `lease`, `generation`, `why` (a start refusal or failure, or `stream-failed`)                                                                                    | A lease was given back before the turn settled.                                                                                                                                                                                        |
| `workspace.backend.connected`   | info                                                                 | `runtimeId` (string or `null`)                                                                                                                                                | The Workspace Host connected to a container, launched or adopted. A new `runtimeId` is a new container run.                                                                                                                            |
| `workspace.container.idle-stop` | info, or warn when `outcome` is `threw`                              | `idleForMs`, `outcome` (`stopped`, `not-running`, `skipped-busy`, or `threw`)                                                                                                 | The idle alarm found nothing in flight for `WORKSPACE_IDLE_STOP_MS` (ADR-0043), closed the Workspace, and tried to destroy the container. `skipped-busy` and `threw` check again one limit later (`src/workspace/idle-controller.ts`). |
| `workspace.reset`               | info                                                                 | `runtimeId`                                                                                                                                                                   | The owner's reset deleted the workspace storage and restarted the container.                                                                                                                                                           |
| `github-credential.install`     | info when connected, error for `credential-rejected`, otherwise warn | `source` (`configured-token` or `device-authorization`), `outcome`                                                                                                            | A token was installed into the workspace.                                                                                                                                                                                              |
| `github-credential.ensure`      | info when connected, otherwise warn or error                         | `before`, `fallbackConfigured`, `outcome`                                                                                                                                     | The Supervisor found the credential missing or rejected and tried the configured token. A working credential writes nothing.                                                                                                           |
| `chatgpt.model-call`            | warn or error                                                        | `outcome` (`retrying`, `refused`, `http-error`, or `stream-failed`), `status`, `type`, `code`, and for a usage limit `fallback` and `limitedUntil`                            | OpenAI refused or failed a model call. `fallback: true` (Workers AI answers instead) is warn. The error message is never logged, because it can name the owner's account.                                                              |
| `chatgpt.refresh`               | error for `rejected`, otherwise warn                                 | `outcome` (`rejected`, `missing-scope`, `temporary`, `rate-limited`, or `ambiguous`)                                                                                          | A token refresh failed. `rejected` and `missing-scope` mean the owner must sign in again; the others kept the stored pair.                                                                                                             |
| `chatgpt.login.complete`        | info, or warn for a refusal                                          | `outcome` (`connected` or a refusal code)                                                                                                                                     | The owner's ChatGPT sign-in finished.                                                                                                                                                                                                  |
| `chatgpt.provider-refused`      | error                                                                | none                                                                                                                                                                          | OpenAI refused a token twice; the connection now needs a reconnect.                                                                                                                                                                    |

Plain `logRedactedCause` lines cover the rest, for example `workspace.idle-alarm: not armed`,
`workspace.idle-stop: container not stopped`, and `<surface>: sync-incomplete` when a clone or
removal did not reach the durable store (`src/workspace/executor.ts`). Container exits and restarts
appear only in Computer's own log lines and in the container metrics.

## Querying

Stream live events with Wrangler. The first element of each log's `message` is the event object:

```sh
pnpm exec wrangler tail cf-stumble --format json \
  | jq -c '.logs[]?.message[0] | objects | select(.event? // "" | startswith("turn."))'
```

For past events, open the Cloudflare dashboard, Workers & Pages, `cf-stumble`, Observability, and
filter on `event` (for example `event = turn.settled`). Workers Logs keeps events for 7 days.

Cloudflare Issues and Workers traces are on (`observability.issues` and `observability.traces` in
`cloudflare.config.ts` and `wrangler.jsonc`); a deployment from a configuration without `issues`
turns Issues off. Issues groups uncaught exceptions, failed invocations, 5xx responses, and
`console.error` output, so an `error` event appears there; it ignores `warn`, and it misses work
that is slow or expensive but succeeds. Every sampling rate is 1. A span is one event in the logs
quota (20 million a month on Workers Paid, then $0.60 per million); one cold start of the workspace
wrote about 12,600 spans. If the bill grows, lower `traces.headSamplingRate` first.

## Checking a running deployment

Run `pnpm ops:check` after a staging deploy or an e2e run, and when the bill looks wrong. It needs a
live account, so it is not part of `pnpm verify`. It checks one thing: a workspace container that
kept running past the Host's idle stop. It prints one check mark when all is well and one line per
finding otherwise, and exits 1 on any finding or `unknown`. `--json` prints the same as JSON.

**Sources.** For the window (`--since 90m|2h|1d`, or `--from <ISO> [--to <ISO>]`), it reads:

- Workers Logs (`workers/observability/telemetry/query`): every fetch invocation of the Worker, with
  its end time, `$workers.wallTimeMs`, and URL, from one idle limit before the window starts. Only
  owner API requests (routes under `/api/`) count; the page and Durable Object fetches never reach
  the workspace.
- GraphQL `containersUsageAdaptiveGroups`: `allocatedMemory` byte-seconds per five-minute bucket,
  divided by the provisioned memory of the `<worker>-workspacehost` application and by 60, gives
  running minutes. A bucket counts at most five minutes.

**Rule `ran-past-idle`.** Each request allows the container to run from its start until its end
plus the idle limit (`--idle-minutes`, default `WORKSPACE_IDLE_STOP_MS`). A run of consecutive
running buckets that exceeds that allowance by more than 10 minutes is a finding. Buckets newer
than 10 minutes are still filling and do not count. The finding lists the routes and end times of
the last three requests before the run ended, which shows what kept the container awake.

**Limits.** A turn that holds the container after its request ended (a turn lease, or a client that
left a streamed turn) is covered only by the 10-minute slack. A stuck container shows up about 30
minutes after the last request with the defaults.

**Credentials.** `CLOUDFLARE_API_TOKEN`, or `--token-file` with a bare token or the `cf` login JSON
(`~/.config/cloudflare/config/default.json`, after `pnpm exec cf auth whoami` refreshed it). GraphQL
needs Account Analytics Read; an API token with it is better for repeated runs. The account is
`--account`, then `CLOUDFLARE_ACCOUNT_ID`, then the only account the token sees. The token goes in
the `Authorization` header only and is never printed. Use `--worker <name>` for another Worker.

**Unknown.** Missing data never reads as fine. A missing token or account, a failed call, a missing
application, an unexpected response, or a query that hit its row limit (2,000 requests or 5,000
usage rows) prints one `unknown` line with the reason. Use a shorter `--since` after a row limit.

The queries are in `tools/ops-check/fetch.mts`. To check whether a stop happened without the
metrics lag, `GET /accounts/<account-id>/containers/applications/<container-app-id>/instances`
lists instances with `status.state` (`running` or `inactive`); the applications list gives the id.
Billing data needs an API token with Billing Read; the `cf` login cannot get that scope.

## Noise from the container

Container output does not pass through the Worker's redaction. Base64 dumps of source text appeared
in the container logs from 2026-09-24 to 2026-09-28, from an unknown source, and none since. If they
come back, find the container log line, then read the upstream code at `COMPUTER_COMMIT`.
