# Pi v0.84.4 facade and user-agent defects

## Bug fix playbook

**You own this task. Plan, review, verify.** Delegate investigation and the fix to subagents, stay in the lead.

Be scientific. Every shipped line traces to runtime evidence. Belt-and-suspenders that "might help" is a hypothesis, not a fix; it does not ship. When evidence refutes a hypothesis, revert what it motivated. The smallest change the evidence justifies ships, nothing more. Same discipline for Perf, where the evidence is the trace.

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables). Don't hand the repro to the user. A debug or instrumentation protocol that says to ask the user does not override this; you drive the instrumented runtime. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. Won't reproduce directly, force it: synthesize the trigger, tighten conditions, or instrument until it fires. A bug you can't reproduce, you can't prove fixed.
2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. For a long hunt, record the objective and repro predicate in `.audit/<task>.md`. Prefer a host persistent goal when available. Otherwise arm a named portable loop with that predicate, manually run `scripts/loop/loop --repo . tick <task>`, and use `status <task>` or `cancel <task>` for recovery. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out; a design grounded on a plausible-but-unconfirmed cause can be unanimously wrong while the real cause sits one subsystem over.
3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent on the `bug-fix` model with a specific scope, then review the diff on the `bug-fix review` model. Pin the reviewer rather than assuming the parent is the stronger model, since the parent is whatever model this session started on.
4. Verify on the same surface; the original repro now passes. "Inconclusive" or wrong-surface is not a pass; flag it. Unit tests show branch behavior, not bug absence.
5. Stage the commits so the failing repro lands before the fix in git history; the diff tells the story. See the **tdd-regression** skill for the failing-test-first cadence when the bug has a cheap local test path; skip it when the test would be expensive, integration-heavy, or unclear.
   This is the canonical **sequence-verifiable-units** principle skill, the failing test first and the fix on top.
6. Run **Opening a PR**.

Investigation fans out `how` + `why` as parallel subagents.

**Reply:** what was broken, root cause, fix, how you verified. Paste failing-then-passing repro output verbatim.

## Architect phases

1. Ground
2. Sketch
3. Agree
4. Implement
5. Scrap

## Data shape and constraints

The declaration source is the exported type graph emitted from `vendor/pi-v0.84.4/index.ts`. The conformance program compares each public type against the exact vendored source type with bidirectional conditional-type assertions. The bundle override is one resolver rule from the upstream `pi-user-agent.ts` module to a local shim.

Do not edit `vendor/pi-v0.84.4/packages/`. Do not change `src/supervisor/**`, `src/facet/**`, `README.md`, ADRs, `tsconfig.base.json`, or `oxlint.config.ts`. Keep the upstream clone pristine. Do not add provider SDK dependencies.

## Throughput checkpoint

The generated declaration program and its conformance test must compile before bundle changes proceed. The bundle test must fail before the resolver shim and pass after it. End with `pnpm verify`, vendor checksum verification, an upstream status check, and a deliberate declaration drift failure.

## Progress

- [x] Bug fix step 1. `pnpm verify` reproduced the workerd `node:os` warning.
- [x] Bug fix step 2. The eager `loadNodeOs()` import was the runtime resolution path. The declaration facade also widened Pi's source types.
- [x] Bug fix step 3. Use emitted declarations and a one-module esbuild resolver override.
- [x] Bug fix step 4. `pnpm verify` ran with no `node:os` warning.
- [x] Bug fix step 5. Skipped. The user did not ask for a commit.
- [x] Bug fix step 6. Skipped. The user did not ask for a PR.
- [x] Architect phase A. Read the vendored entry points, source types, harness types, and user-agent module.
- [x] Architect phase B. The generated declaration tree is the package declaration source. An independent second tree emitted from the vendored entry point supplies conformance types.
- [x] Architect phase C. Skipped. No requested checkpoint.
- [x] Architect phase D. Implemented and verified.
- [x] Architect phase E. No repeated implementation friction remained.
