# Run the workspace container on a machine Aditya provides

> **Review:** Agent-only

The Workspace Host can run its workspace container on a machine Aditya owns, such as his Mac with
OrbStack, instead of as a Cloudflare Container. The machine runs `stumble orb provider
<dispatch-script>`, which opens every connection itself, so it needs no inbound port, as with Amp's
self-hosted orbs. When no provider is connected, the Host uses the Cloudflare container as before.

**Seam.** Computer 0.8.0's `ContainerBackend` drives a container only through
`IWorkspaceContainerAPI`. `ProviderContainerAPI` (`src/workspace/provider-container.ts`) implements
it over the provider's socket, and the Host builds a second `ContainerBackend` on top of it. The
Workspace sees one backend (`src/workspace/workspace-platform.ts`), which picks the provider when
one is connected and the Cloudflare container otherwise, each time the Workspace connects. The idle
stop and a reset stop whichever container is running.

**The provider's socket.** One outbound WebSocket from the provider to the Host, at
`GET /orb/provider` with a provider token. The Host accepts it with WebSocket hibernation and
answers the provider's `ping` with an automatic `pong`, so a connected provider with no container
costs nothing. JSON frames (`src/orb-protocol.ts`) carry:

- jobs from the Host: `start` (with the container's environment), `stop` (idle stop) and `delete`
  (reset). The provider runs the dispatch script once per job, with the job in environment
  variables, and answers `job-done` or `failed`. `start` prints the address of the container's
  port 8080.
- `fetch` from the Host: the setup calls `ContainerBackend` makes to port 8080 (`/health`, the
  `/api` auth check, `POST /connect`, `/__computerd/info`), answered with `fetch-result`.
- `hello` and `exited` from the provider: its local listener's port, and a container that stopped
  on its own (the dispatch script's `wait`).

**computerd's connection.** `POST /connect` tells computerd to dial
`http://computer.internal:<port>`, the provider's local listener, which the dispatch script maps to
the machine with `--add-host computer.internal:host-gateway`. The listener answers `/health` and
pipes the `/api` WebSocket upgrade byte for byte over a second outbound connection to
`/orb/computerd` on the Worker, which the Host hands to `ContainerBackend.handleFetch`. computerd
authenticates with its own bearer secret there, as it does on Cloudflare. A byte pipe needs no
WebSocket server in the provider and no relay in the Host. While computerd is connected, its open
request keeps the Host active, exactly as on Cloudflare, and the idle stop (ADR-0043) applies
unchanged: it sends a `stop` job.

**Token.** The provider token is the Worker secret `ORB_PROVIDER_TOKEN`. Aditya sets it out of
band with `cf workers secrets update`, or from CI, and the Alchemy stack never declares it, so a
deploy keeps it (`docs/deploy.md`, "Instance secrets"). The provider presents it from
`STUMBLE_ORB_TOKEN`, and the Host compares the SHA-256 digests of the two values with
`crypto.subtle.timingSafeEqual`. When the secret is unset or empty, both `/orb/provider` and
`/orb/computerd` refuse every request, so a deploy without the secret behaves as before this ADR. A
workspace reset leaves the secret alone. The token is required because a provider runs code on
Aditya's machine and receives the whole workspace, including the GitHub credential. There is no
HTTP route that mints or reads it, because owner routes have no authentication yet. To revoke a
provider, change the secret. That deploys a new Worker version, which closes the provider's
socket, and the old value no longer connects.

**Failure.** When the provider's socket closes, the Host fails every request it sent on it, marks
the container exited, and the next connect falls back to the Cloudflare container. Files in
SQLite survive, as after any container replacement; files under ignored segments do not. The
provider stops its container when its socket closes or when it receives SIGINT or SIGTERM, because
every later connect launches a fresh container anyway. It then connects again, waiting from 1 to 30
seconds between attempts, so a Worker deploy does not end it.

**Alternatives.** Carrying computerd's WebSocket frames on the job socket would need a WebSocket
server in the provider and an in-memory relay in the Host, which keeps the Host awake just the same.
Sending computerd straight to the Worker fails because `ContainerBackend` gives computerd an
`http://` base. A Cloudflare Tunnel to the machine would need an inbound route and an account
resource for each machine.

**Backend setting.** The Host stores one setting, `provider` (the default) or `cloudflare`, set
with `GET`/`POST /api/workspace/backend` and a control in the page sidebar. `provider` uses a
connected provider and falls back to Cloudflare, as above. `cloudflare` always uses the Cloudflare
container. The choice is made at connect time (`WorkspacePlatform`), so a change affects the next
container start. A change while a container runs closes the workspace and stops the container, as
the idle stop does, so the next command starts on the chosen backend. It is refused while a run is
active. A workspace reset keeps the setting.
