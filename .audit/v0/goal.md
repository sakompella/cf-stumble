# cf-stumble v0 goal

Deploy an owner-only coding agent that streams useful work on one connected GitHub project and can activate or roll back a labeled harness commit without losing project files or the current Pi conversation.

## Completion checklist

1. The release commit passes `pnpm verify`. Release notes identify the SHA, Computer source and image pair, model route, and deployment commands.
2. Cloudflare Access admits only the owner. Authenticated owner requests reach the Supervisor, connected project, shared workspace, generation state, and saved thread. Unauthenticated requests fail.
3. One GitHub repository connects through authorization that is separate from Access. One Computer workspace contains that repository and the harness repository. Git and `gh` use local credentials outside repositories. Credentials never appear in tracked files, application logs, browser responses, module maps, or saved facet state.
4. The page has a project sidebar and a streaming conversation. One real turn reads a file, edits it, runs the repository check, and shows tool activity, command output, and a diff before reporting saved completion.
5. Each project has one current Pi thread and accepts one active turn. Repository instructions and managed instructions reach Pi. Starting a fresh thread removes its conversation and compacted context while preserving repository files.
6. Pi terminal success and a committed thread save define a completed turn. Tested lease fencing prevents stale completion or cancellation from changing a replacement turn.
7. The owner builds and cold-checks a visibly different harness commit, activates it with the observed epoch, and continues the same project conversation. A deliberately broken candidate fails while the active generation serves. Manual rollback to an earlier ready generation that ran before preserves the edit and thread. Repeated submissions and active-target no-ops work without a request journal. Stale epochs reject.
8. The deployment does not rely on a local fake to prove the demo path.
9. A human-made two-minute recording demonstrates the seven-step workflow in `docs/agents/design/feature-map.md`. Keep the paid probe output and release notes with the recording. Publication needs an owner decision and does not block acceptance.

## Cut line

Manual rollback is the only recovery behavior in version 0. Do not add automatic repair, promotion, known-good policy, background turns, reconnect or resume, a provider picker, subscription login, public signup, an admin console, a browser IDE, or project-to-project security isolation. Stop when this checklist passes.

## Evidence

Every checklist item needs a command result, automated test, paid probe artifact, browser recording, or release note at the release SHA. Local baseline evidence in `/tmp/cf-stumble-v0/verify-baseline.log` proves only the reviewed starting commit. It is not a release result.
