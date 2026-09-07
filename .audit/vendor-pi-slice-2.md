# Vendor Pi slice 2

## Feature playbook

1. `how` over the affected subsystem.
2. `architect` for parallel design exploration. Skipping stays as `architect skipped: <reason>`; do not fold the design decision silently into implementation.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Delegate code-writing to a subagent using your configured feature model (default `grok-4.6-fast-xhigh`) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain** — a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic — and success criteria); review its diff yourself. When the implementation admits multiple valid shapes (error handling, abstraction layer, test structure), delegate via the **arena** skill instead so the runners surface the alternatives and the cross-judge guards the pick. Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved). You can spawn a subagent even though you are one; "the app is small" and "a subagent cannot spawn one" are both wrong. A subagent forbidden to spawn satisfies this by owning the diff directly with the same review separation; no "standing by" reply that waits on a nested agent. Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass; flag it.
6. Rebase into small, ordered commits; stack follow-ups.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.
7. If the design is contested, `interrogate` before shipping.
8. Run **Opening a PR**.

Code-coupled work (one feature, one migration) goes to a single owner with the checkpoint inline; that owner fans out internally after the blocking phase. Parent-level fan-out is for slices that produce independent artifacts (audits, cross-subsystem investigations, competing experiments). Rewrite the checkpoint at phase boundaries; spawn a fresh owner rather than chaining interrupts.

## Architect phases

1. Ground
2. Sketch
3. Agree
4. Implement
5. Scrap

## Throughput checkpoint

- [x] Blocking first steps. Read the upstream pin, plan sections 2, 4, and 5, repository architecture, build settings, and source entry points before changing files.
- [x] Independent workstreams. Source-copy validation and local package build are connected through one generated manifest, so one owner must serialize them. Tests and gate plumbing follow the generated package.
- [x] Shared mutable state. `vendor/pi-v0.84.4` is one generated tree. `tools/vendor-pi.mts` is its only writer, and the update step recreates it rather than coordinating edits.
- [x] Smallest safe decomposition. The available execution context has no nested Agent tool. I will keep one owner for the shared generated tree and review its concrete diff and verification output directly.

## Work units

- [x] Ground. Read the affected repository configuration and upstream imports. The managed vendor tree will contain upstream source under `packages/`, a generated root entry point, package metadata, and one generated SHA256 manifest.
- [x] Sketch. Use an `UpstreamPin` JSON object as the external data model. `tools/vendor-pi.mts` parses it, validates the source checkout, copies paths, renames upstream `index.ts` files to `index.upstream.ts` so only the root has `index.ts`, writes generated package files, and hashes every managed input file.
- [x] Agree. Keep the emitted JavaScript as a single esbuild bundle and use TypeScript declaration emission from a narrow root entry. This avoids a hand-written type facade if upstream declarations compile under a dedicated relaxed config.
- [x] Implement. Created the source copier, package build, workspace and verification wiring, and tests.
- [x] Verify. The copier check, package build, focused lint, and `pnpm verify` passed.
- [x] Scrap. Pi declaration emission reached its full provider graph and required unbundled provider SDKs. Replaced it with a generated narrow declaration facade, rather than adding dependencies or lint exceptions.
- [ ] Opening a PR. Skip because the user asked for local implementation and did not ask for a PR.
