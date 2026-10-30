# Architecture decisions

This directory records current decisions. Every ADR declares whether a human approved it or an agent recorded it without human approval. Read the human-approved decisions first: they take precedence over agent-only records when the two conflict. When a decision no longer applies, delete its ADR; Git retains the historical record. `test/docs/adr-index.test.ts` checks that this index names every ADR in the directory.

Add an ADR only for a decision that is expensive to reverse, has a real alternative, and would surprise a reader of the code. Keep it short.

## Human-approved decisions

- **[ADR-0002](0002-generations-are-materialization-attempts.md)**: a generation is one specific, labeled Git commit in the harness repository.
- **[ADR-0003](0003-supervisor-sqlite-controls-activation.md)**: the primary Supervisor Durable Object checks requested generation changes and alone updates protected generation state.
- **[ADR-0024](0024-facet-owns-the-evolvable-harness.md)**: the main facet owns all mutable harness code and may request a generation candidate, activation, or rollback; the supervisor checks and performs or rejects each request.
- **[ADR-0026](0026-adopt-computer-for-facet-work-environment.md)**: use the verified Computer source and image pair, without fixing the workspace layout or Worker artifact format.
- **[ADR-0027](0027-use-labeled-commit-as-loader-identity.md)**: the labeled harness commit ID is the Worker Loader identity.
- **[ADR-0037](0037-stream-real-turns-to-the-browser.md)**: version 0 streams Pi turns to the browser and credits only terminal, saved success.
- **[ADR-0038](0038-one-thread-per-project-one-shared-workspace.md)**: each GitHub project has one current Pi thread, while one Computer workspace contains all of the owner's repositories.
- **[ADR-0039](0039-treat-the-workspace-as-a-development-machine.md)**: the shared workspace has unrestricted internet, normal development tools, and local GitHub credentials.

## Agent-only decisions

- **[ADR-0028](0028-harness-artifacts-are-module-maps.md)**: a generation's executable form is a module map, and a bundle is a one-module map.
- **[ADR-0042](0042-build-computerd-from-source-with-walk-patch.md)**: the workspace image builds computerd from the pinned source with a patch that stops its shim from following symlinks and walking ignored trees.
- **[ADR-0043](0043-workspace-host-stops-its-idle-container.md)**: the Workspace Host stops its container after ten idle minutes, because computerd's open WebSocket keeps the object active.
- **[ADR-0044](0044-poll-the-shim-disk-walk-every-five-seconds.md)**: the workspace image polls the shim's disk walk every five seconds, because sync reconciles before every pull anyway.
- **[ADR-0045](0045-use-effect-inside-the-immutable-host.md)**: the immutable host composes asynchronous work and recoverable failures with Effect; boundaries keep plain values, pure decisions and SQLite transactions stay synchronous, and each entry point runs its program once.
- **[ADR-0046](0046-serve-the-owner-page-script-as-a-hashed-file.md)**: the owner page is a Foldkit application whose script the Worker serves as a content-hashed, immutable same-origin file, under `script-src 'self'`.
- **[ADR-0047](0047-use-the-owners-chatgpt-subscription.md)**: the model route answers from the owner's ChatGPT subscription once connected, with the credential cached in Supervisor SQLite and never visible to a facet, and from Workers AI until then.
- **[ADR-0048](0048-run-the-agent-loop-on-pi-durable.md)**: the main harness runs its agent loop on one pinned Pi Durable version, with the session in the serving facet's storage under one name for every generation, while the Supervisor keeps alarms, the project-to-conversation map, workspace capabilities and the run deadline.
