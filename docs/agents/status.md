# Status

This file records what runs in production, what was decided outside an ADR, and what is still
open. It was checked against `main` at `86fb16f` on 2026-10-09. Refresh it in place when the state
changes; Git keeps the history. It does not replace an ADR or a design document.

## What is deployed

Production is the Worker `cf-stumble`, deployed only with `cf deploy`. The last deploy was on
2026-10-02. The version ids and their content come from the deploy messages; the commit boundaries
are not recorded. The work after `c620d825` is the `ops:check` tool, which does not ship in the
Worker, and every commit from `4636cc5` to `86fb16f` changes only docs. Run
`pnpm exec cf workers deployments list` before you assume that production matches `main`.

| Version    | Content                                                               |
| ---------- | --------------------------------------------------------------------- |
| `1cfa826f` | The `cf` migration, `exports`, instance secrets, traces, and Issues.  |
| `a70c5499` | The durable GitHub credential and build output returned to the owner. |
| `b5fe4294` | The idle stop and the 5 s shim poll.                                  |
| `c620d825` | The alarm retry, the poll cap, and the alarm logs.                    |

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
- **Per-instance values are Worker secrets that no file declares.** See `docs/deploy.md`, "Instance
  secrets".

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
    directories, and compaction policy; and rollback epoch checks, streamed startup-check errors,
    and Computer file bounds. Seven proposed whole-test deletions were never reviewed.
12. **Code leads** from the 2026-09-27 audit, not confirmed as defects. An older GitHub device
    redemption can clear a newer pending code. Late refusals can write status into a newly selected
    project's page. The turn-stream frame ceiling counts UTF-16 code units, not UTF-8 bytes
    (`src/supervisor/projects/turn-stream.ts`). Command decoders have no end-of-stream flush. The
    directory listing returns every entry. The Computer tarball verifier reads an ignored checksum
    file. Container preflight treats the Dockerfile path as an image. The Docker runtime stage and
    package feeds are not pinned. Browser launch and DevTools attach failures leave no cleanup.
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
