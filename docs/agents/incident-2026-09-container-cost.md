# Incident: container cost, September 2026

The workspace container ran far longer than anyone asked it to on 2026-09-26 and 2026-09-27, and
the Containers overage on the 2026-09-27 invoice came to $4.30. This record gives the timeline, the
causes, the evidence, the fixes with their commits, how to detect a recurrence, and what is still
unknown. Read it with `docs/agents/design/observability.md`, "Checking a running deployment", and
ADR-0043 and ADR-0044.

## Summary

| Item                                                                                                   | Value                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invoice (2026-09-27, as reported; the $4.30 equals the sum of the container lines in the usage export) | $10.25: Workers Paid $5.00, Containers overage $4.30, and an unclassified remainder of $0.95 (no invoice line items were read)                    |
| Container running time                                                                                 | 2.74 h on 09-25, 18.39 h on 09-26, 18.79 h on 09-27, 4.47 h on 09-28                                                                              |
| Container size                                                                                         | `standard-3` (2 vCPU, 8 GiB memory, 16 GB disk)                                                                                                   |
| Causes                                                                                                 | A client that called a paid route about every 95 s; a never-ending WebSocket that kept the Durable Object active; an idle disk walk that used CPU |
| Fixed (three of four causes)                                                                           | The stop and the walk (ADR-0043, ADR-0044); the credential loss that made status reads fail                                                       |
| Not fixed                                                                                              | A client that polls a route that touches the workspace still keeps the container up. `ops:check` detects it.                                      |

The aggregated daily charges are in `docs/agents/evidence/container-cost-2026-09.json`.

## Timeline

All times are UTC. Running hours come from GraphQL `containersUsageAdaptiveGroups` and match the
billing totals; they are an estimate from adaptive buckets, not physical start and stop times.

- **2026-09-24 and 09-25.** Container charges of $0.20 and $0.61. The container ran 2.74 hours on
  09-25.
- **2026-09-26.** An agent end-to-end pass left a client that called `GET /api/github/connection`
  about every 95 seconds: 655 calls, median duration about 90 seconds, most canceled by the platform.
  Each call ran a container command with a 900-second ceiling. CPU was about 7,000 CPU-seconds per
  hour from 07:00 to 21:00, nearly both vCPUs, and it overlapped the polling. The container ran 18.39
  hours and cost $3.49.
- **2026-09-27.** The container ran every hour from 00:00 through the 18:00 hour, one instance, one
  deployment. It used 2,200 to 3,800 CPU-seconds per hour (0.6 to 1.0 vCPU) while memory stayed at
  4.18 GiB and disk at 4.66 GB. The logs held about four events. It stopped after the 18:00 hour,
  for a reason nobody recorded. It ran 18.79 hours. The charge for that day, $1.82, falls in the next
  billing cycle.
- **2026-09-28.** 4.47 running hours ($0.52).
- **2026-10-02.** An investigation found the causes below. Fixes were deployed the same day.

The usage export reports the invoice of 09-27 as covering the cycle from 08-27 to 09-26. Of its $4.30 overage, $3.49 is 09-26.

## Root causes

1. **A status read is paid container work.** `GET /api/github/connection` calls
   `GitHubConnection.status`, which runs `gh auth status` and `gh api user` in the container. Each
   call wakes the container or keeps it busy. A client that repeats the call every 95 seconds keeps
   the container running all day. The page itself does not poll; the client in this incident was an
   agent end-to-end pass. Its exact source, and why the platform canceled calls at about 90
   seconds, were not established.
2. **The container never stopped, because computerd's WebSocket never ended.** computerd opens a
   WebSocket back to the Workspace Host. Computer's container backend accepts it as an ordinary
   WebSocketPair and nothing in cf-stumble closed it. An open incoming request keeps a Durable
   Object active, so the platform never saw the object as inactive and never stopped its container.
   Evidence: one `GET http://computer.internal/api` invocation ran 56 minutes and another 26. A
   staging container with the heartbeat off ran 26 minutes untouched; after `Workspace.close()` it
   stopped in about 100 seconds, and after `destroy()` in one second. The 20-second heartbeat and
   the extra `monitor()` call were ruled out: the container stopped 98 seconds after a release,
   well inside both 15-minute windows. `setInactivityTimeout` cannot help, because it only counts
   after the object is inactive.
3. **An idle container used CPU, because the shim walked the disk every 250 ms.** The userspace
   shim runs a full `lstat` walk of `/workspace` four times a second whether or not anything
   changed. On staging, with no requests, computerd used 0.4% of a vCPU with one file, 0.40 vCPU
   with 4,040 files, and 1.0 vCPU with 10,102 files: about 0.1 vCPU per 1,000 entries, and nothing
   for files under an ignored segment. This explains production's 0.35 to 0.5 vCPU idle load. It is
   an inference for 09-27 itself: nobody sampled the processes that day.
4. **The GitHub credential did not survive a container replacement.** `gh` and Git wrote their
   configuration under `/root`, which is outside the durable `/workspace`. Every new container
   started without a credential, so status reads reported `workspace-unavailable` or
   `disconnected`. This did not cost money by itself, but it produced the error traffic and hid the
   problem while `GH_TOKEN` quietly reinstalled the credential. See
   `docs/agents/design/github-connection.md`, "Where the credential lives".

## Fixes

| Cause                  | Fix                                                                                                                                               | Commits                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 2, never-ending socket | The Workspace Host stops an idle container: an alarm closes the Workspace, then destroys the container after ten minutes with no work (ADR-0043). | `0521455`, `632e1aa`, `ff9ce47`, `2ca99c7`, then `d5b83e3` to `2dc6512`, `ee43f84`, `281f2bb` |
| 3, shim walk           | The shim polls every 5 s (`COMPUTERD_POLL_MS`), with a cap at the timer limit (ADR-0044).                                                         | `53366fb`, `58b8d26`                                                                          |
| 4, lost credential     | `gh` and Git configuration live under `/workspace`.                                                                                               | `3adf75c` to `fad987a`                                                                        |
| Visibility             | Container events, request ids, `route.settled`, traces, Issues, and `pnpm ops:check`.                                                             | `71f03be` to `f8b03b3`, `c0816a9`, `94ef17c` to `4636cc5`                                     |

Cause 1 has no code fix. The idle stop does not help against a client that keeps calling a route
that touches the workspace, because each call counts as work. The defenses are detection
(`ops:check` rule `poller`) and the stop that follows ten minutes after the client goes away.

Production verification on 2026-10-02: the last work ended at 21:31:20Z and the stop fired at
21:41:20Z (`reasonCode: idle-stop`, `outcome: stopped`). The instances API showed `inactive` one
second later.

## Detecting a recurrence

Run `pnpm ops:check` after a deploy, after an end-to-end run, and when the bill looks wrong. The
rules that matter here:

- `poller`: a route called 20 or more times in a rolling hour, with at least 10 touching the
  workspace or over 10% canceled. The 09-26 client would have fired it within the first hour.
- `ran-past-idle`: running time beyond the idle limit after the last owner activity.
- `unowned-cpu`: 30 minutes of CPU above about 0.1 vCPU with no owner work in the logs.
- `running-close` and `unexplained-stop`: container stops that were not an intentional Host stop; their cause is unknown.

`docs/agents/design/observability.md`, "Query recipes", has the queries behind each rule so you can
run them by hand. The cost check is: compute running minutes from the usage dataset, compare them
with the days in the billing data, and expect agreement.

## What is still unknown

- Why the 09-27 container stopped after the 18:00 hour.
- What the 09-26 client was, and why the platform canceled its calls at about 90 seconds.
- Why the container sometimes stops early with an unknown reason after a transport close while
  `running` is `true`. It happened at about 16:03Z, 16:32Z, and 21:25Z on 2026-10-02. These are
  not an intentional Host stop; the cause is unknown.
- Which process used the CPU on 09-27. The shim walk fits the numbers and was reproduced on staging;
  no process list from that day exists.
- Billing data needs an API token with Billing Read. The `cf` OAuth login cannot read it.
