# better-result pilot plan audit

Playbook: Multi-phase or multi-PR plan. Steps copied verbatim, each marked done or skipped.

1. Skip the plan for a one- or two-file change with an obvious approach. Say why and stop.
   - not skipped. The slice touches seven tracked files, adds a runtime dependency, and gates on human ADR approval.
2. Settle observable questions with `playbooks/prototype.md` before writing. Keep the branch, SHA, and artifact links in the plan. Ask the operator only about a product or preference call that no run can settle.
   - done by source verification instead of a prototype. Four API questions were answered by reading `better-result` v3.0.1 source. Installing the package to answer them would have pre-empted the ADR gate.
3. Explore through scoped subagents. Each returns file pointers, conventions, test commands, and entry points. Do not inline dumps.
   - done. Two prior background agents produced the adoption audit and this pilot plan.
4. Copy the skeleton into `.audit/<program>-plan.md` and fill every placeholder. One section covers one PR or independently verifiable phase. Name dependencies, evidence, and the execution playbook.
   - adapted. The plan lives at `docs/agents/design/_better-result-pilot-slice.md` because it holds a draft ADR that a human reviews with the other design documents. This file carries the checklist.
5. Prefer a host persistent goal when available. Its objective and done predicate must match the checklist. Otherwise use the named portable loop and manual commands in the plan. An optional host adapter may invoke those commands, but the plan must remain valid without it.
   - done. A host goal is active. Its predicate matches the done predicate below.
6. Run `node skills/poteto-mode/scripts/check-plan.mjs <plan.md>` and fix every reported line. The validator checks the portable plan contract rather than a host-specific workflow.
   - see the validator entry below.
7. Hand back the plan path and checker output, then stop. Execution starts only on the operator's explicit go.
   - the ADR approval gate is the operator's go.

## Program checklist

- [x] Durable checklist path. `.audit/better-result-pilot.md`.
- [x] Durable objective. Complete the pilot plan so another agent can execute it without this conversation.
- [ ] Done predicate. `pnpm verify` passes and `test/supervisor/rpc-surface.test.ts` proves a plain structured-cloneable RPC return after the package runs in workerd. Not satisfiable before ADR-0035 approval.
- [x] Cadence. Reconsider when the operator approves or rejects ADR-0035.
- [x] Named loop. `better-result-pilot-audit`.
- [x] Predicate. `pnpm verify`.
- [x] Arm it. `skills/poteto-mode/scripts/loop/loop --repo . arm better-result-pilot-audit --objective "complete the better-result pilot plan" --predicate "pnpm verify" --interval 900`.
- [x] Manual tick. `skills/poteto-mode/scripts/loop/loop --repo . tick better-result-pilot-audit`.
- [x] Recovery. `skills/poteto-mode/scripts/loop/loop --repo . status better-result-pilot-audit`, `skills/poteto-mode/scripts/loop/loop --repo . cancel better-result-pilot-audit`, then `skills/poteto-mode/scripts/loop/loop --repo . unlock` only when it confirms a dead local PID.
- [x] Optional host adapter. The active host goal references this checklist and runs the same predicate.
- [x] Forge predicate. skip. Nothing is proposed upstream. The repository is local and ahead of its remote by 45 commits, and this run opens no review request.

## Decisions recorded this run

Each decision is written into the plan's `## Decisions` section with evidence.

- [x] D1. Drop the `ResultType` import alias.
- [x] D2. Keep `error.match(...)` as an instance call. Risk resolved against source.
- [x] D3. Keep `message` and `cause` in every tagged-error payload.
- [x] D4. Keep explicit type arguments in the race, try dropping them in the mount.
- [x] D5. Delete the one-use `CandidateFacet` and `HeaderResult` aliases.

## Close

- [ ] Every checklist item is checked or marked skipped with a reason.
- [ ] The done predicate passed and the evidence is linked above.
