# Status

This file records what runs in production, what was decided outside an ADR, and what is still
open. "What is deployed" was refreshed on 2026-10-13 against `main` at `f4191af`; the open items
were last checked against `86fb16f` on 2026-10-09. Refresh it in place when the state changes; Git
keeps the history. It does not replace an ADR or a design document.

## What is deployed

Production is the Worker `cf-stumble`, deployed only with `cf deploy`. It runs `27fdbd1`, deployed
on 2026-10-16 at about 07:40 UTC as Worker version `563aee12`, with container application version 51
and generation `eafaf99` active at epoch 3. That release carries the Effect and Foldkit port, the
cancel fix, the review fixes, and the ChatGPT provider. It was staged first on a throwaway Worker
(`.audit/cleanup-2026-10/release-27fdbd1.md`). GitHub is connected through the configured token,
and no project is connected. ChatGPT was connected with the owner's account and then disconnected,
because the first ChatGPT turn hit `subscription_sharing_usage_limit_exceeded`; turns answer from
Workers AI. Later commits on `main` (the follow-up fixes, the usage-limit fallback, the pinned
container image) are not deployed. Run `pnpm exec cf workers deployments list` before you assume
that production matches a commit.

Checked on the 2026-10-16 staging run: the idle stop fired 600 s after the turn lease ended, a
cancelled turn freed its lease within seconds, and the first turn after the stop saved.

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
- **An ended turn's capability refuses file access as well as commands** (owner default,
  2026-10-13). Before, ending a turn killed its commands but left reads and writes open, and main's
  capability had no deadline at all. See `design/computer-integration.md`, "Workspace layout".
- **A fresh thread or a workspace reset is refused while a turn runs** (owner default, 2026-10-13).
  The answer is HTTP 409 `turn-active`, or `workspace-busy` when the Workspace Host is running a
  file change or credential install. The alternative, cancelling and fencing the running turn, is
  not built. See `design/computer-integration.md`, "Workspace layout".
- **Work that starts during a workspace reset is refused** (owner default, 2026-10-15). While a reset
  runs, the Supervisor answers a new turn, a connect, a disconnect, or a second reset with HTTP 409
  `workspace-busy`, and the Workspace Host refuses file changes, credential installs, and project
  capabilities. Waiting for the reset instead is not built. See `design/computer-integration.md`,
  "Workspace layout".
- **A refused generation control answers HTTP 4xx** (owner, 2026-10-16). Submission, activation,
  and rollback refusals answer 400 for an invalid commit or label, 404 for an unknown generation,
  409 for `stale-epoch`, `not-ready`, and `not-previously-active`, and 403 for
  `revoked-capability`, instead of 200. The body still carries `ok: false` and the problem code,
  and a successful no-op stays 200. Activation and rollback now write `route.settled`, so a refusal
  shows there as `refused`. See `src/routes/generations.ts`.
- **The model route uses the owner's ChatGPT subscription once connected** (owner, 2026-10-13).
  The Supervisor caches the credential; Workers AI answers until a connection exists. See
  ADR-0047 and `docs/deploy.md`, "Connect ChatGPT". Not deployed yet: production still answers
  from Workers AI only.

## Open items

1. **Polling clients still cost money.** A client that keeps calling a route that touches the
   workspace keeps the container running, because each call counts as work. There is no code fix;
   `pnpm ops:check` rule `poller` detects it. See the incident record, "Not fixed".
2. **Early platform stops with an unknown reason.** On 2026-10-02 the container stopped after a
   transport close while `running` was `true`, at about 16:03Z, 16:32Z, and 21:25Z. These are not
   Host stops, and their cause is unverified. `ops:check` reports them as `running-close` and
   `unexplained-stop`.
3. **Process accounting is not built.** A staging sampler showed computerd's shim walk as the only
   CPU user, which fits production's idle load. Production's processes were never sampled.
4. **Artifacts checkpoint pilot.** Deferred. It needs the owner to approve a new paid product.
5. **Live Computer paths not proved.** Two staging runs on 2026-09-28 connected and disconnected a
   public repository. They did not induce `sync.status: "pending"` or skipped entries, so the
   `workspace-sync-incomplete` branch is tested only with local fakes. No run proved a partial copy
   across Workspace Host eviction, or that the clone was absent from the store after removal. The
   project lifecycle queue and the shell lock are not proved to order work across eviction and the
   post-command sync. See `design/github-connection.md`, "Partial copies".
6. **Test leads** from the 2026-09-28 review, at an older commit. Reproduce each before you act:
   weak composition coverage of the Supervisor class; whether the HTTP and Playwright persistence
   tests now catch dropped prompts or history; facet mutations for empty tool lists, ignored
   directories, and compaction policy; and streamed startup-check errors and Computer file
   bounds. Seven proposed whole-test deletions were never reviewed.
7. **Code leads** from the 2026-09-27 audit, not confirmed as defects. The vendor hash checks
   compare with the local manifest, not with upstream Pi.
8. **Runtime behavior that needs a platform test.** Overlapping same-commit startup checks may
   abort each other. When a provider reports no usage, or a negative or fractional count, the
   route estimates usage from bytes, which can undercount. Workspace exclusion during a turn is
   isolate-local, not held by the Workspace Host.
9. **Owner decisions.** Whether the repository size thresholds in `src/github/repository-size.ts`
   need an ADR. A self-hosted remote runner (computerd behind a Cloudflare Tunnel) was researched
   on 2026-09-27; the note is lost and nothing was decided.
10. **ChatGPT is unproved end to end.** On 2026-10-16 the agent tool connected the owner's account
    headless, and the first turn hit `subscription_sharing_usage_limit_exceeded`, so no real
    ChatGPT answer has streamed yet. `main` now falls back to Workers AI with a notice on a usage
    limit and keeps the connection. After that is deployed, reconnect with
    `tools/chatgpt-connect.mts`, run one turn, and check `chatgpt.model-call`.
