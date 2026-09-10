# Version 0 feature map

Version 0 is a public repository with a deploy-to-your-own-Cloudflare-account feature. The front door is a "Deploy to Cloudflare" button. The deployed instance remains owner-only through Cloudflare Access. This document defines the work that remains and the cut line.

## What version 0 still needs

1. Keep one connected GitHub project. Show it in the sidebar with the harness as a second sidebar entry. The harness entry selects `/workspace/harness` as the working directory. It does not create another project or another session.
2. Keep one current Pi thread for each project. Starting a fresh thread replaces that project conversation and compacted context. It keeps the repository files.
3. Keep one shared durable Computer workspace. The harness clone and the connected project have separate directories and Git histories, but those directories are not security boundaries.
4. Complete one real coding turn. The agent must read the selected repository, make a small edit, run its configured check, stream its response, and show the diff and command output. The saved project thread and project edit must survive a generation change.
5. Keep the turn lease. It prevents a stale turn from changing a replacement turn. The demo does not use automatic repair, promotion rules, per-turn accounting, relay records, or recovery reports.
6. Build each candidate from its named harness commit. The Supervisor must run the `build:artifact` phases, one build step each, store the resulting module map in Supervisor SQLite, cold-check `GET /`, and leave the active generation serving when the candidate fails.
7. Activate a passing candidate and roll back to an earlier generation that ran before. Activation and rollback load stored module maps. They do not rebuild code. Repeating a submission for a known commit returns its existing generation.
8. Keep R2 out of version 0. Its binding, cache code, cache tests, rebuild-on-cache-miss behavior, corruption recovery, cache age rule, double-build gate and SQLite schema deletion check are all deleted, and the module map lives in Supervisor SQLite instead.
9. Keep Cloudflare Access as the owner-only gate. The Worker derives the Supervisor name from the verified Access identity and audience. No request supplies that name. Multi-user work is after version 0.
10. Build the page that shows the active generation, the selected working directory, the streaming conversation, the project sidebar, and generation controls.
11. Deploy early to a paid Cloudflare account. Prove the demo path against the deployed Worker, Dynamic Worker facets, Computer workspace, Worker Loader, and model route. Keep the deployed evidence that a failed candidate leaves the active generation serving and that rollback loads a stored module map without a build.
12. Add user-facing deploy documentation and the "Deploy to Cloudflare" button. The button uses the public source repository and deploys into the user's own account. Document what the button cannot configure, including Workers Paid, Cloudflare Access, the Computer backend, and GitHub authentication inside the workspace.
13. Prove the fresh-account bootstrap sequence from empty storage.

## Demo

1. Open the Access-protected page and see the active generation.
2. Select the connected GitHub project or the harness entry in the sidebar. Ask the agent to make one small change.
3. Watch the response stream while the agent reads the project, edits a file, runs the configured check, and shows the diff and command output.
4. Submit a second harness commit. The Supervisor builds it, cold-starts a candidate facet, and runs `GET /`.
5. Activate the passing candidate. Continue the same conversation in the same workspace.
6. Submit a deliberately broken candidate. Its startup check fails while the active generation continues to serve.
7. Roll back to the earlier generation. The conversation and project edit remain present.

The demo defines the feature cut line. Delete code only when none of these steps depend on it for behavior, authorization, or persistence. Keep it when that answer is uncertain.

## Harness self-edit path

`/workspace/harness` is the owner's editable harness checkout and a real Git clone. The agent edits and commits there with ordinary Git. A candidate submission names that commit SHA. The build runs `git archive` from the harness repository into `/workspace/.builds/<commit>` and builds in that directory. The harness sidebar entry only selects `/workspace/harness` as the working directory. It needs no separate commit machinery.

## Fresh-account bootstrap

1. The deployed Worker serves requests until a generation exists. The Supervisor performs bootstrap without an active main facet.
2. The harness repository URL comes from one Wrangler variable. The deploy button creates the user's fork, or the user sets the URL manually.
3. On the first authenticated owner request, or an explicit owner bootstrap action, the Supervisor provisions the workspace and clones that URL into `/workspace/harness`.
4. The Supervisor labels the clone HEAD commit as the first candidate and uses the normal submission path. It runs the `build:artifact` phases, one build step each, stores the module map in SQLite, cold-checks `GET /`, and activates a passing candidate.
5. Repeating a submission for a known commit returns its existing generation. A failed bootstrap build leaves the deployed Worker serving and reports the failure.
6. With `CF_ACCESS_*` unset or only partly configured, every Worker route fails closed with `invalid-configuration`. The deploy documentation must state this because the button deploys before the user configures Access.
7. Remove the production fixture from application construction.
8. Run this sequence once with a genuinely empty account and empty storage before publishing the deploy documentation.

## Release-gate cuts

Do not require a forced-compaction test. Pi owns compaction. Record compaction across reload as a known untested area in the deploy documentation.

Do not require paid evidence for browser disconnects or deadlines. Do not require shared-container concurrency evidence or GitHub credential reconnect evidence.

## Deliberately postponed

- Choosing an automatic promotion rule or activating a fallback automatically.
- Letting the agent repair itself, submit generations, or approve changes through replay tests.
- Reconnect, resume, steering, and background turns beyond the disconnect behavior required for a correct streamed turn.
- Combined project and harness views.
- Public signup, teams, roles, invitations, tenant administration, or a custom account system.
- Provider selection and subscription login.
- Better cache policy, alarms, and thread migrations.

## Ideas that are not part of this release

- `patch.md` profiles
- code-server
- Cloudflare OS Gadget or Blueprint compatibility
- Issue triage, CI webhooks, and a product-level pull-request workflow
- custom Git object storage, Artifacts compatibility, and a Git protocol server
- skills, MCP, plugin, and tool marketplaces
- a metrics dashboard, full admin console, canaries, quarantine, attestations, and garbage collection
- the DO-backed Trustix log, R2 Nix cache, rate limiter, sharded KV store, and other distributed-systems demos
