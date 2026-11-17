# The Workspace Host stops its idle container

> **Review:** Agent-only

The Workspace Host stops the workspace container itself when the workspace has had no work for ten
minutes (`WORKSPACE_IDLE_STOP_MS`). An alarm checks, `decideIdleStop` decides, and the
Host pulls the container's changes, closes the Computer `Workspace`, and then destroys the
container with the reason `idle`.

The platform would not stop it. Computer's container backend accepts a WebSocket that computerd
opens back to the Workspace Host (`GET http://computer.internal/api`), and nothing in cf-stumble
closes it. That socket is one incoming request that never ends, and an incoming request keeps a
Durable Object active, so the object never becomes inactive and the platform never stops the
container "shortly after the Durable Object becomes inactive". On production one such request ran
56 minutes and another 26, and a staging container with no heartbeat ran 26 minutes untouched.
Idle containers also burn CPU, because computerd's disk poll walks `/workspace` every 250 ms.

**Rules.** Work counts as in flight from the start of a Host RPC (`build`, `provision`,
`removeProject`, `ensureManagedInstructions`, `credential`, `reset`) and of each project `exec`
until it settles, even past the turn deadline. `project()` leases the workspace until the turn
deadline, and a lease ends when the capability's turn ends (`endTurn`), as when the Supervisor
ends a run's capability at settle or abort, or at its end time, whichever comes first. The
lease set (`src/workspace/idle-leases.ts`) drops a lease whose end time has passed, so a Host
that nobody told about the end of the turn answers a backend change after the deadline. The WebSocket and the heartbeat are not work. The alarm closes the Workspace, checks
again that nothing began meanwhile, and only then destroys the container. Work that begins during
the close keeps the container, and the check repeats one limit later. A close that fails does not
stop the destroy, because destroying the container ends the socket from the other side. The Host
arms the alarm only while a container runs, once per quiet period or earlier when a lease ends
early, and the alarm sets no timer, so it cannot keep the object in memory. The container's stop is logged as the Host's own doing
(`reasonCode: "idle-stop"`), whichever way the platform's `monitor()` settles.

**Cost of a stop.** The next request after a stop builds a fresh container, which takes a cold
start. An idle stop loses what a platform restart loses: files the sync does not copy into the
Durable Object's SQLite, such as `node_modules`, `/tmp`, and anything outside `/workspace` or under
an ignored segment. Everything else is kept, because SQLite is the authority, every exec pulls
the container's changes before it settles, and the stop pulls once more before the close, so a
file that a background process (a dev server, `cmd &`) wrote after the last exec is kept too. A
write made after that pull is lost. The stop pulls when this Host instance has connected to the
container or when the platform reports it running (`ctx.container.running`).

A deploy resets the Host (`codeUpdateStrategy: immediate`) and nothing wakes the new instance until
a request or the alarm, so the object is inactive and the platform stops the container shortly
after (23 seconds after a deploy on a staging stage, with no pull). The Host therefore sets the
container's inactivity timeout to one idle limit plus a minute, when it connects and when it starts
beside a running container. The container then outlives the reset until the alarm wakes the new
instance. A new instance counts itself idle for one limit already, so the alarm that wakes it
stops the container at once; a request that wakes it first counts as activity, as before. (Counting
idle time from the instance's start made each woken instance rearm, and with the inactivity timeout
the container never stopped.) Its pull connects first: Computer's `start()`
finds the container running with the same launch record and adopts it (`outcome: "adopted"`, the
same runtime id), and the pull copies what a background process wrote since the last exec. If the
launch record differs (a changed container environment, instance size or ignore list), Computer
destroys and relaunches the container instead, those writes are lost, and the stop pays one cold
start; Computer has no adopt-only connect to avoid it. The pull is bounded at 60 seconds and runs once, and a pull that fails or times out does not
stop the destroy. When it fails, the Host logs the failure and logs
`workspace.container.idle-stop` with `outcome: "writes-may-be-lost"` before the destroy, because
a write made since the last pull is then lost with the container. (An earlier version pulled
twice. No run showed a failed first pull, and a timed-out first pull is not cancelled, so the
second pull ran beside it.) The snapshot taken before an idle stop has its own 60-second bound
and does not stop the destroy either.

**Alternatives.**

- `setInactivityTimeout` only counts after the object is inactive, which never happens here, so it
  cannot stop an idle container; the Host uses it only to keep a container through a reset.
- Turning the heartbeat off changes nothing; the open request alone keeps the object active.
- Closing the Workspace without destroying the container works, but the stop comes 70 to 140
  seconds later and the object is already gone, so nothing can log it.
- Changing Computer's backend to a hibernatable WebSocket is an upstream change and much larger.

**Races.** An exec counts as in flight before it reaches the Workspace, and it waits for any stop
in progress before it starts. A stop that sees work in flight after the close keeps the container
and checks again one limit later. The check and the destroy follow each other with no wait between
them, and an exec that begins after the destroy has started waits for it to finish and then
launches a fresh container.

**One stop at a time.** One permit (`src/workspace/idle-controller.ts`) serializes the stops: the
alarm's idle stop and the stop for a backend change each run under it, and `settled()`, which
waits for a stop in progress, takes the same permit for a moment. The permit is released whatever
way the stop ends, so work waiting on a stop never outlives it, including a stop that cannot arm
its next alarm (a failed `setAlarm` rejects the alarm, so the platform runs it again). A backend
change that arrives during an idle stop waits for the permit and then stops the container if it
still runs (work began during the close, or the destroy failed); it pulls and closes again
before it destroys. `stopForBackendChange` rejects with the destroy's own error when that destroy
fails, and work waiting on the stop goes on either way. A provider `stop` or `delete` job that gets
no answer in 30 s drops the provider's socket (ADR-0050), so a stop never waits forever.
