# Live Computer check, 2026-09-28

Two temporary Cloudflare deployments tested the project connection path from source commit `74a8d5a473f2709dd507f0186daad0b667ee685f`. They used a separate Worker name, fresh Durable Object namespaces, and separate standard-1 Container applications. Neither deployment changed the production Worker, its route, its container, or its connected projects. Both temporary Workers and Containers were deleted and their absence checked after the runs.

The tests used `octocat/Hello-World`, a small public GitHub repository, and a disposable self-signed test identity. The staging deployments held no GitHub secret and submitted no harness generation, so they ran no harness build or Workers AI turn. The test key, JWT, and the owner's Firefox cookies are not in this record.

## Observed requests

| Check                               | First deployment                                                                            | Second deployment                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Worker version                      | `92f12752-a35e-447e-a3d6-e94385df060c`, then `4b8a9bfa-c3b1-4aa5-8151-21fd0c2d6381`         | `4bea1677-1e4b-44c9-8c44-92bd78a53614`                   |
| `GET /api/status` before connection | HTTP 200, epoch 0, no active generation                                                     | HTTP 200, epoch 0, no active generation                  |
| Connect the public repository       | HTTP 200, `ok: true`, `alreadyConnected: false`, id `octocat-hello-world`                   | HTTP 200, `ok: true`, `alreadyConnected: false`, same id |
| Disconnect                          | HTTP 200, `workspace: "removed"` after the Container had gone idle and resumed; 3.4 seconds | HTTP 200, `workspace: "removed"`                         |
| Project list after disconnect       | Only the harness entry remained                                                             | Not recorded independently                               |

The first deployment used Worker `cf-stumble-staging-lcv` and Container application `a03ffaa5-fa5e-4845-bc43-c31a3a32a103`. The second used Worker `cf-stumble-staging-lcv2` and Container application `a03f42d1-461e-46ae-a6fd-4ae5e5bca95a`. Their Durable Object namespace IDs differed from production and from each other. After cleanup, Cloudflare reported that both Workers no longer existed and listed only the production Container application.

A separate read-only `GET /api/status` against production used the owner's existing Firefox Access session. It returned HTTP 200 with active generation label 5 at harness commit `7465a299fda7b88e5b43b9170498c3e4b4848fdc`. Production was not running the source under test. The cookie values were neither printed nor retained.

## What this does not prove

The connect response exercises the deployed code path that requires a complete Computer sync and checks clone markers in the durable store. The disconnect response exercises the deployed complete-sync and absence checks. These are real application results, but no second reader independently inspected the stored files after removal.

The first run deleted its Worker before the planned filesystem inspection. In the second run, `wrangler containers ssh` could not open a shell even while the instance was running. Cloudflare accepted the SSH-session request, then rejected the WebSocket upgrade with HTTP 400 on two client attempts. The cause was not established. The absence of `/workspace/projects/octocat-hello-world` and its `.provisioning` directory was therefore not independently measured.

Neither run induced `sync.status: "pending"` or skipped entries. The `workspace-sync-incomplete` branch remains tested with local fakes, not live Computer. These runs also did not prove behavior across a failed partial copy, Workspace Host eviction, or a replacement container restoring a partial clone. See [GitHub connection](design/github-connection.md#partial-copies) for the remaining recovery risk.

The sanitized [first-run responses and resource IDs](evidence/live-computer-2026-09-28-run-1.json) and [second-run responses and resource IDs](evidence/live-computer-2026-09-28-run-2.json) are committed with this record. Neither file contains cookies, a private key, or a test JWT.
