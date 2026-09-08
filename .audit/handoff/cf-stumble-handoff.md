# cf-stumble handoff

## Session

- Current Delta thread: [Review Prior CF Stumble Work](delta://thread/ksQQZPDQsEn5T52KfVapjzz88ZLNHk2SAcQQ-4vupFJCT9mkbwBTdFP9vQ)
- Thread ID: `ksQQZPDQsEn5T52KfVapjzz88ZLNHk2SAcQQ-4vupFJCT9mkbwBTdFP9vQ`
- Worktree: `cf-stumble` (`d90d94ed-dded-4b1a-a304-c471836e3877`)
- No other persisted Delta thread was identified as a source for these decisions.

## Outcome

The user approved the version-0 architecture in documentation and explicitly deferred the corresponding generation-control and workspace implementation work.

Three commits now capture the completed work. The architecture commit establishes three decisions:

1. Generation commands do not use request IDs, command fingerprints, or an idempotency journal. Candidate resubmission returns the existing generation, activation of the active generation is a no-op, and activation/rollback retain epoch checks.
2. Each connected GitHub project has one current Pi thread, while the owner's harness and all project repositories occupy separate directories in one shared Computer workspace. Selecting a project chooses the prompt thread and starting directory; shared storage does not merge conversation histories, but it is not a repository security boundary.
3. The shared workspace behaves like a normal development machine with unrestricted internet, `git`, `gh`, package tooling, and locally stored GitHub credentials. The agent may push directly or open a pull request according to the request, permissions, and repository conventions.

Pi remains the agent core. The explicit `toolExecution: "sequential"` override and its sequencing-only test were removed, leaving scheduling to Pi's default behavior.

Do not re-document these decisions elsewhere. Read the ADRs and inspect `git diff` for exact changes.

## Authoritative documents changed

### Decisions and glossary

- [Glossary: `docs/agents/CONTEXT.md`](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/CONTEXT.md)
- [ADR index: `docs/agents/adr/README.md`](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/adr/README.md)
- [ADR-0030: apply generation requests directly](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/adr/0030-apply-generation-requests-directly.md)
- [ADR-0031: relay facts decide known-good](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/adr/0031-relay-facts-decide-known-good.md)
- [ADR-0032: recovery bounds an episode](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/adr/0032-recovery-bounds-an-episode-it-does-not-perform.md)
- [ADR-0033: generation-control epoch](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/adr/0033-epoch-versions-generation-control-state.md)
- [ADR-0035: better-result process boundaries](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/adr/0035-use-better-result-only-inside-process-boundaries.md)
- [ADR-0038: one thread per project, one shared workspace](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/adr/0038-one-thread-per-project-one-shared-workspace.md)
- [ADR-0039: shared workspace as development machine](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/adr/0039-treat-the-workspace-as-a-development-machine.md)

ADR-0030 moved from agent-only to human-approved. ADR-0038 and ADR-0039 remain human-approved but replace their prior files and decisions. The old files were deleted and their replacements committed intentionally.

Deleted/replaced paths:

- `docs/agents/adr/0030-generation-requests-are-journaled-and-epoch-bound.md`
- `docs/agents/adr/0038-one-thread-and-workspace-per-project.md`
- `docs/agents/adr/0039-treat-project-workspaces-as-development-machines.md`

### Current design documents aligned to the ADRs

- [`docs/agents/design/overview.md`](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/design/overview.md)
- [`docs/agents/design/computer-integration.md`](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/design/computer-integration.md)
- [`docs/agents/design/feature-map.md`](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/design/feature-map.md)
- [`docs/agents/design/slices.md`](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/docs/agents/design/slices.md)

The design cleanup also removed stale claims that the Worker artifact format was undecided. The current docs consistently describe Computer building canonical module maps and R2 caching rebuildable output under the labeled harness commit.

## Source and tests changed

- [`src/facet/generation-0/pi-agent-turn.ts`](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/src/facet/generation-0/pi-agent-turn.ts): removed the explicit sequential tool-execution option.
- [`test/facet/generation-0/pi-agent-turn.test.ts`](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/test/facet/generation-0/pi-agent-turn.test.ts): removed the test that required sequential execution.
- [`test/docs/managed-instructions.test.ts`](worktree://d90d94ed-dded-4b1a-a304-c471836e3877/test/docs/managed-instructions.test.ts): follows the renamed ADR-0039 and shared-workspace terminology.

## Commits

The work was committed on `main` as an ordered series:

1. `61ac8b2 refactor(facet): use Pi's default tool scheduling`
2. `2f37ff3 docs(architecture): simplify control and workspace decisions`
3. `d6ff238 docs(design): align version zero architecture`

No commit was pushed during this session.

## Verification and repository state

- Each commit passed the tracked pre-commit verification hook.
- A final `pnpm verify` passed: 93 test files, 642 tests.
- `git diff --check` passed before committing.
- The working tree was clean after `d6ff238`.
- Do not claim the new workspace or generation-control architecture is implemented. ADR-0030 explicitly records the remaining request-journal cleanup, and `computer-integration.md` records the current per-project/build workspace mismatch.

## Likely next work

Only begin these if the user asks for implementation:

1. Remove `requestId`, command fingerprints, and `generation_control_journal` across routes, RPC types, Supervisor storage/control logic, UI, and tests while retaining epoch-based stale-write protection.
2. Replace per-project Computer workspace naming and the separate harness-build workspace with one owner/tenant workspace and repository-relative directories. Preserve one thread and active-turn lease per project.
3. Implement GitHub repository connection authorization separately from Cloudflare Access identity, without exposing credentials to tracked files, browser responses, logs, or mutable facet state.
4. Verify shared-container concurrency behavior and decide what must serialize when two project turns use the single container.

Follow `docs/agents/domain.md` before architecture or implementation work and run `pnpm verify` before claiming success.

## Suggested skills

Call the Skill tool for:

- `domain-modeling` when changing ADRs, glossary terms, or the workspace/generation model.
- `typescript-best-practices` before reading or editing TypeScript implementation files.
- `agents-sdk` and `durable-objects` for Supervisor, thread, state, RPC, or facet work.
- `cloudflare` and `workers-best-practices` for Computer bindings, Worker configuration, Dynamic Workers, credentials, and production boundaries.
- `tdd` when implementing the deferred journal removal or shared-workspace migration.
- `code-review` for a review of commits `61ac8b2..d6ff238` or any later implementation branch.
