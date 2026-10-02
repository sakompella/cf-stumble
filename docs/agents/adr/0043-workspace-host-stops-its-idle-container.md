# The Workspace Host stops its idle container

> **Review:** Agent-only

The Workspace Host stops the workspace container itself when the workspace has had no work for ten
minutes (`WORKSPACE_IDLE_STOP_MS`). An alarm checks, `decideIdleStop` decides (ADR-0036), and the
Host closes the Computer `Workspace` and then destroys the container with the reason `idle`.

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
deadline. The WebSocket and the heartbeat are not work. The alarm closes the Workspace, checks
again that nothing began meanwhile, and only then destroys the container. Work that begins during
the close keeps the container, and the check repeats one limit later. A close that fails does not
stop the destroy, because destroying the container ends the socket from the other side. The Host
arms the alarm only while a container runs, once per quiet period, and the alarm sets no timer, so
it cannot keep the object in memory. The container's stop is logged as the Host's own doing
(`reasonCode: "idle-stop"`), whichever way the platform's `monitor()` settles.

**Cost of a stop.** The next request after a stop builds a fresh container, which takes a cold
start. Nothing is lost: the Durable Object's SQLite is the authority, and every exec pulls the
container's changes before it settles.

**Alternatives.**

- `setInactivityTimeout` only counts after the object is inactive, which never happens here.
- Turning the heartbeat off changes nothing; the open request alone keeps the object active.
- Closing the Workspace without destroying the container works, but the stop comes 70 to 140
  seconds later and the object is already gone, so nothing can log it.
- Changing Computer's backend to a hibernatable WebSocket is an upstream change and much larger.

**Residual race.** A project `exec` that starts in the instant between the final busy check and
the destroy meets a container that is going away. It fails like any exec on a restarted container,
and the next one launches a fresh container.
