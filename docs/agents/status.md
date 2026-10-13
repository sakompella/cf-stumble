# Status

This file records what runs in production, what was decided outside an ADR, and what is still
open. "What is deployed" was refreshed on 2026-10-13 against `main` at `f4191af`; the open items
were last checked against `86fb16f` on 2026-10-09. Refresh it in place when the state changes; Git
keeps the history. It does not replace an ADR or a design document.

## What is deployed

Production is the Worker `cf-stumble`, deployed only with `cf deploy`. It runs `1a60802`, deployed
on 2026-10-12 at about 09:20 UTC as Worker version `4bc2112f`, with container application version
50 and generation `eafaf99` active at epoch 3. GitHub is connected through the configured token
(`configured-token`), and no project is connected. `main` at `f4191af`, 45 commits later and
carrying the Effect and Foldkit port (item 15), is not deployed. Run
`pnpm exec cf workers deployments list` before you assume that production matches either commit.

Checked in production on 2026-10-02: the idle stop fired ten minutes after the last work (see
`incident-2026-09-container-cost.md`), and the GitHub connection stayed connected across the image
rolls between 21:23Z and 21:31Z. On staging, with a 3-minute limit, the stop came 180 s after the
last work, and a 270 s exec kept the container up until 180 s after it ended.

## Decided outside an ADR

- **No Bombadil for now** (owner, 2026-09-28). Do not add it to `pnpm verify` or run a pilot.
- **Keep the second `monitor()` call** (owner, 2026-10-02). Reading Computer's stored exit instead
  was examined and rejected. The reasoning is in `design/observability.md`, "What the container
  events do not show".
- **Skip Cloudflare Artifacts for now.** See `design/computer-integration.md`, "Artifacts
  (deferred)".
- **Agents use a service token instead of the owner's sign-in** (owner, 2026-10-12). The owner
  asked for prod to be readable without signing in to Access. A Service Auth policy on the
  `stumble` Access application admits one service token, and the Worker admits that token as the
  owner when `CF_ACCESS_AGENT_CLIENT_ID` names it (`src/access/index.ts`). It reaches the owner's
  Supervisor. Every other service token is still refused. See `docs/deploy.md`, "Agent access
  without a sign-in".
- **Per-instance values are Worker secrets that no file declares.** See `docs/deploy.md`, "Instance
  secrets".
- **Reset Supervisor state once instead of migrating it** (owner, October 2026). Production's
  Supervisor dropped every table except `github_authorization` and `github_connection` on
  2026-10-12 at 08:38:33Z (9 tables, 35 rows). The reset code is removed; the `legacy_state_reset`
  table stays. See `design/github-connection.md`, "The connected project list".

## Open items

1. **Polling clients still cost money.** A client that keeps calling a route that touches the
   workspace keeps the container running, because each call counts as work. There is no code fix;
   `pnpm ops:check` rule `poller` detects it. See the incident record, "Not fixed".
2. **Early platform stops with an unknown reason.** On 2026-10-02 the container stopped after a
   transport close while `running` was `true`, at about 16:03Z, 16:32Z, and 21:25Z. These are not
   Host stops, and their cause is unverified. `ops:check` reports them as `running-close` and
   `unexplained-stop`.
3. **First turn after an idle stop.** The Host marks the next connect as not a replacement
   (`ContainerLifecycle.stoppedByHost`), so the first project exec should not report
   `container-restarted`. Only unit tests cover this. Check it on staging.
4. **Process accounting is not built.** A staging sampler showed computerd's shim walk as the only
   CPU user, which fits production's idle load. Production's processes were never sampled.
5. **Artifacts checkpoint pilot.** Deferred. It needs the owner to approve a new paid product.
6. **Registry images.** On 2026-10-09 the registry held 16 `cf-stumble-workspacehost` tags
   (production uses `c620d825`) and one `cf-stumble-computerd` tag. Delete the old ones with
   `wrangler containers images delete` once nobody wants to roll back to them.
7. **Leftover R2 bucket.** `cf-stumble-module-maps` still existed on 2026-10-09, although version 0
   keeps module maps in Supervisor SQLite. Deleting it needs the owner's OK.
8. **Unpushed `main`.** Local `main` is 185 commits ahead of `origin/main`. Push only with the
   owner's explicit OK (`issue-tracker.md`).
9. **Worktrees.** `git worktree list` showed 6 worktrees on 2026-10-09. The three under
   `../.worktrees` hold uncommitted owner work; do not remove them.
10. **Live Computer paths not proved.** Two staging runs on 2026-09-28 connected and disconnected a
    public repository. They did not induce `sync.status: "pending"` or skipped entries, so the
    `workspace-sync-incomplete` branch is tested only with local fakes. No run proved a partial copy
    across Workspace Host eviction, or that the clone was absent from the store after removal. The
    project lifecycle queue and the shell lock are not proved to order work across eviction and the
    post-command sync. See `design/github-connection.md`, "Partial copies".
11. **Test leads** from the 2026-09-28 review, at an older commit. Reproduce each before you act:
    weak composition coverage of the Supervisor class; whether the HTTP and Playwright persistence
    tests now catch dropped prompts or history; facet mutations for empty tool lists, ignored
    directories, and compaction policy; and streamed startup-check errors and Computer file
    bounds. Seven proposed whole-test deletions were never reviewed.
12. **Code leads** from the 2026-09-27 audit, not confirmed as defects. Late refusals can write status into a newly selected
    project's page. The turn-stream frame ceiling counts UTF-16 code units, not UTF-8 bytes
    (`src/supervisor/projects/turn-stream.ts`). Command decoders have no end-of-stream flush. The
    directory listing returns every entry. The Computer tarball verifier reads an ignored checksum
    file. The Docker runtime stage and package feeds are not pinned. Browser launch and DevTools attach failures leave no cleanup.
    Terminal turn status has no concise live-region announcement. The vendor hash checks compare
    with the local manifest, not with upstream Pi.
13. **Runtime behavior that needs a platform test.** Overlapping same-commit startup checks may
    abort each other. A provider JSON error followed by `[DONE]` may be ignored. Missing or
    malformed provider usage can undercount. Producer cancellation after a browser disconnect is
    untested. Workspace exclusion during a turn is isolate-local, not held by the Workspace Host.
14. **Owner decisions.** What a workspace reset does to a running turn (refuse, or cancel and
    fence). Whether the repository size thresholds in `src/github/repository-size.ts` need an ADR.
    A self-hosted remote runner (computerd behind a Cloudflare Tunnel) was researched on
    2026-09-27; the note is lost and nothing was decided.
15. **Port to Effect and Foldkit done locally, not deployed** (owner, 2026-10-12). ADR-0045 moves the
    immutable host to Effect, and ADR-0046 makes the owner page a Foldkit application served as a
    hashed script file. better-result is gone from the code and the lockfile. The Worker, Cloudflare
    Access, the owner API routes, and the model route's provider stream run as Effect programs,
    through `runAtEntryPoint` at the native entry points and `runResponseBody` for a streamed body.
    The Supervisor's module maps, builds, startup checks, generation control, and thread store, the
    Workspace Host's surfaces, idle check, and provisioning, the credential calls, the GitHub
    clients, the turn lifetime, and the project workflows are Effects. Synchronous stores and
    parsers return `effect/Result`, and the RPC, JSON, SQLite, and module-map values are unchanged.
    The page is a Foldkit program, checked by Foldkit's oxlint plugin. Out of scope: the mutable
    harness (`src/facet/generation-0`), vendored Pi and Computer, and the tools under `tools/`, which
    keep native Node APIs. The bundle budgets are 600 KiB gzip for the Worker and 216 KiB gzip for
    the page script. Staging must still check the script route, its `immutable` cache header, and
    the `script-src 'self'` policy behind real Cloudflare Access; Worker startup time; a real
    container stop, exec, and first turn; and a turn streamed and cancelled through the deployed
    Worker. Local `wrangler check startup` profiles hold too few samples to compare.
