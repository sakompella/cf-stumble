# Bug fix

**You own this task. Plan, review, verify.** Delegate investigation and the fix to subagents, stay in the lead.

Be scientific. Every shipped line traces to runtime evidence. Belt-and-suspenders that "might help" is a hypothesis, not a fix; it does not ship. When evidence refutes a hypothesis, revert what it motivated. The smallest change the evidence justifies ships, nothing more. Same discipline for Perf, where the evidence is the trace.

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables). Don't hand the repro to the user. A debug or instrumentation protocol that says to ask the user does not override this; you drive the instrumented runtime. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. Won't reproduce directly, force it: synthesize the trigger, tighten conditions, or instrument until it fires. A bug you can't reproduce, you can't prove fixed.
2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with Cursor's `/loop` command. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out; a design grounded on a plausible-but-unconfirmed cause can be unanimously wrong while the real cause sits one subsystem over.
3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent on the `bug-fix` model with a specific scope, then review the diff on the `bug-fix review` model. Pin the reviewer rather than assuming the parent is the stronger model, since the parent is whatever model this session started on.
4. Verify on the same surface; the original repro now passes. "Inconclusive" or wrong-surface is not a pass; flag it. Unit tests show branch behavior, not bug absence.
5. Stage the commits so the failing repro lands before the fix in git history; the diff tells the story. See the **tdd-regression** skill for the failing-test-first cadence when the bug has a cheap local test path; skip it when the test would be expensive, integration-heavy, or unclear.
   This is the canonical **sequence-verifiable-units** principle skill, the failing test first and the fix on top.
6. Run **Opening a PR**.

**Reply:** what was broken, root cause, fix, how you verified. Paste failing-then-passing repro output verbatim.

# Architect

1. Ground. Complete. The failing Workers test reports one credited turn after an unrelated label. The relay stamps `ActiveGeneration.epoch`, which moves for every protected-state change, while eligibility compares that value to a history row recorded at activation.
2. Sketch. Complete. `activationId` is an independently monotonic counter in `generation_state`, incremented only by a non-no-op activation. `ActivationHistory` owns its durable history and lookup. Active generation, relay attribution and facts, eligibility evidence, and recovery selection expose `activationId`, leaving `epoch` exclusive to staleness checks.
3. Agree. No checkpoint requested. The user specified the required separation and module seam.
4. Implement. Complete. `ActivationHistory` owns both activation records and prior-activation lookup. `Generations` owns the counters and returns the current activation identifier only while a generation is active.
5. Scrap. Not needed. The type model compiled without casts or special cases, and the targeted regression and full gate pass.

## Throughput checkpoint

After the schema and type rename compile, run the targeted evidence-era test. Complete. After the history extraction and all caller migration, run `pnpm verify`. Complete with 63 passing tests.
