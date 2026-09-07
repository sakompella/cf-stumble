# cf-stumble v0 goal

Deploy an owner-only coding agent that streams useful work on connected GitHub projects and can activate or roll back a labeled harness commit without losing project files or the current Pi conversation.

## Done criteria

1. The exact release commit passes `pnpm verify`. Release notes identify the SHA, Computer source/image pair, model route, and reproducible deployment commands.
2. Cloudflare Access admits only the owner. Two authenticated browsers reach the same Supervisor, connected projects, shared workspace, generation state, and saved threads. Unauthenticated requests and attempts to select another tenant fail.
3. At least two GitHub repositories are connected through authorization separate from Access. One Computer workspace contains those repositories and the separate harness repository. Git and gh work with local credentials outside repositories. Credentials never appear in tracked files, application logs, browser responses, R2 maps, or saved facet state.
4. The page has a collapsible project sidebar and a streaming conversation. One real turn reads a file, edits it, runs the repository's check, and shows tool activity, command output, and a diff before reporting saved completion.
5. Each project has one current Pi thread and accepts one active turn. Repository instructions and managed instructions reach Pi. A forced-compaction test continues from saved Pi context. Fresh thread removes conversation and compacted context while preserving every repository's files.
6. Success requires Pi terminal success and a committed thread save. A rejected, failed, truncated, cancelled, or unsaved turn earns no completed-real-turn credit. Tested lease fencing prevents stale completion or cancellation from changing a replacement turn. Paid evidence records actual disconnect and deadline behavior.
7. Two clean Computer builds of the same labeled commit produce identical canonical module maps. A cold cache hit loads without rebuilding; a missing or corrupt R2 map rebuilds under the same commit identity. A simple cache age rule is configured. Failed builds do not change the active generation.
8. The owner builds and cold-checks a second visibly different harness commit, activates it with the observed epoch, and continues the same project conversation. A deliberately broken candidate fails while the active generation serves. Manual rollback to an earlier ready, previously active generation preserves the edit and thread. Repeated submissions and active-target no-ops work without a request journal; stale epochs reject.
9. Paid restart/eviction checks preserve active selection, connected-project records, threads, and project files. Shared-container concurrency and GitHub credential persistence/reconnect behavior have recorded outcomes. The release does not rely on a local fake to prove those properties.
10. A two-minute recording demonstrates the seven-step workflow in `docs/agents/design/feature-map.md`. Its file, paid probe output, and release notes are retained. Publish it to the owner's approved destination. Any publication blocker remains explicit.

## Cut line

Manual rollback is recovery. No automatic repair or promotion, known-good policy project, background turns, reconnect/resume feature, provider picker, subscription login, public signup, admin console, browser IDE, or project-to-project security isolation is required. Stop after the done criteria pass.

## Evidence required

Every done criterion points to a command result, automated test, paid probe artifact, or browser recording at the release SHA. Local baseline evidence in `/tmp/cf-stumble-v0/verify-baseline.log` proves only the reviewed starting commit. It is not a release result.
