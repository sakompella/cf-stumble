# cf-stumble

cf-stumble is a self-modifying agent harness. The agent may revise its own definition, but the supervisor decides which revisions may run. This glossary keeps authored history, materialization attempts, and live operation separate.

## Language

### History and identity

**Commit**:
An ordinary Git revision in authored history. A commit does not show that anything ran.
_Avoid_: generation, release, deployment

**Authored history**:
The Git commit DAG for an agent definition and its ancestry. It does not record which generations were live.
_Avoid_: generation history, activation history

**Working tree**:
A mutable checkout used to assemble a commit. It is scratch space, not an immutable revision or generation.
_Avoid_: generation, snapshot

**Generation**:
One attempted facet materialization for a commit, identified by a number that never repeats. Like a NixOS generation, it is a numbered attempt, but it is an agent attempt rather than an operating-system boot entry.
_Avoid_: commit, snapshot, version, revision

**Generation registry**:
The authoritative catalogue of generations and their materialization records. Tags name Git revisions; the registry identifies attempts.
_Avoid_: tags, generation refs, generation list

**Generation 0 (genesis)**:
The known-good initial generation and guaranteed recovery target. It is a recovery point, not a branch or a boot entry.
_Avoid_: root commit, default branch, initial commit

**Candidate**:
A generation under consideration for activation. This is a role before first promotion, not a different content type.
_Avoid_: draft, proposed commit, untrusted commit

**Baseline**:
The live generation used to evaluate a candidate. It records the operational starting point, not the candidate's commit parent.
_Avoid_: parent, predecessor, previous commit

**Artifact**:
The concrete agent definition loaded for one materialization attempt. It records what ran, rather than only the selected commit.
_Avoid_: commit, source, build output

### Attempts and activation

**Materialization**:
The result of trying to turn a commit into a running facet. It records what was tried and whether it became usable; it does not say that the generation was live.
_Avoid_: activation, deployment, promotion

**Activation**:
An event that makes one generation live. A generation can be activated more than once, so activation differs from its one materialization attempt.
_Avoid_: materialization, generation status, deployment

**Activation ledger**:
The ordered record of activation events. The registry answers what was attempted; the ledger answers when it was live.
_Avoid_: generation history, status history, changelog

**Live pointer**:
The generation number of the current activation. It names a materialization attempt, not only a commit.
_Avoid_: live branch, current commit, active ref

**Promotion**:
An activation that makes a validated candidate live. It decides the fate of a generation; it is not a Git operation.
_Avoid_: merge, deploy, publish

**Rollback**:
An activation that returns to a generation that was live before. It does not rewrite authored history or erase later activations.
_Avoid_: undo, revert, reset

**Reset**:
The recovery activation that returns directly to genesis. It remains available when ordinary recovery rules deny every other target.
_Avoid_: rollback, revert, restart

**Quarantine**:
A restriction on ordinary reactivation of one generation. It marks a bad attempt, not a commit that must fail in every context.
_Avoid_: blacklist, ban, rejected commit

**Attestation**:
The supervisor's validation evidence for a candidate, baseline, artifact, and evaluation context. It is evidence for that exact situation, not caller-supplied approval.
_Avoid_: approval token, validation token, certificate

### The agent boundary

**Supervisor**:
The trusted authority outside the agent definition that controls generations and activation. It is not agent-authored code and cannot become a candidate.
_Avoid_: agent, facet, controller

**Facet**:
The isolated compartment where one generation's agent code runs. It is the subject of materialization, not that materialization's record.
_Avoid_: generation, sandbox, worker

**Facet capability**:
Authority available to the active harness for ordinary work, including its tool registry, runtime, and workspace. It may evolve with the agent definition, but it never grants direct access to supervisor recovery state.
_Avoid_: supervisor access, recovery authority

**Agent workspace**:
The facet-owned mutable environment for tasks and harness development. A Computer Workspace may back it, but it is ordinary agent state rather than supervisor recovery state.
_Avoid_: supervisor workspace, recovery store

**Computer Workspace**:
The workspace API supplied by `@cloudflare/computer`, which may implement an agent workspace. Use this name when referring to that API rather than the domain concept.
_Avoid_: workspace (when the platform API is meant)

**Worker-shell backend**:
The `@cloudflare/computer` backend that runs just-bash over a virtual filesystem. It has shell syntax and core utilities but no OS processes, compiler, or package installation.
_Avoid_: container backend, Linux runtime

**Container backend**:
The `@cloudflare/computer` backend that runs `computerd` in a Linux process environment. It can compile and run project tooling, at the cost of awake time, cold starts, and a larger credential and image surface.
_Avoid_: Worker-shell backend

**Four primitives**:
The tool registry generation 0 ships with: `read`, `write`, `edit`, and `bash`. They are the bootstrap tool registry, not a permanent ceiling on what a later agent definition is allowed to grow into, because the facet's harness is meant to evolve. They are one part of the harness, not the whole of it: the harness also covers the model loop, prompts, policies, runtime, and workspace.
_Avoid_: fixed action space, permanent capabilities, bootstrap harness

**Agent definition**:
The versioned material that describes agent behavior: model loop, tool registry, prompt, policy, skills, and agent-authored modules. It excludes the supervisor and accumulated context.
_Avoid_: agent state, supervisor configuration, runtime state

**Prompt, policy, and skills**:
Parts of an agent definition. The prompt directs the model, policy states constraints, and skills give reusable task guidance. They can change with the model loop, tool registry, and other harness modules.
_Avoid_: runtime state, accumulated context

**Accumulated context**:
Knowledge and history that survive across generations without joining the agent definition. Rollback does not rewind it.
_Avoid_: generation state, commit state, snapshot state

### Evaluation and execution

**Turn**:
One interaction with the agent, from input to result. A turn is operational work, not a commit or a materialization attempt.
_Avoid_: session, generation, task

**Turn pinning**:
The rule that each turn uses the generation live when it started until it finishes. An activation during the turn cannot change its behavior.
_Avoid_: live reload, mid-turn migration

**Executor**:
The part of an agent definition that turns model responses into tool calls and effects. The validation gate evaluates the candidate executor, so it checks the behavior that would run.
_Avoid_: model, facet, individual tool

**Replay session**:
A recorded interaction that reproduces a sequence of model responses, primitive calls, and observable effects. It checks compatibility, not whether a prompt is better.
_Avoid_: benchmark, quality trial, live trial

**Compatibility corpus**:
The replay sessions used to check that a candidate preserves established executor behavior. It does not measure agent quality in general.
_Avoid_: quality benchmark, validation corpus, training set

**Validation gate**:
The process that evaluates a candidate before promotion. It preserves a compatibility floor; it does not claim that the candidate improved the agent.
_Avoid_: quality gate, evaluator, promotion

**Ratchet**:
The gate rule that a candidate must not turn a baseline success into a failure. It retains known behavior without classifying existing failures as regressions.
_Avoid_: score, quality metric, benchmark

**Canary**:
A compatibility case that must pass independently and whose identity is protected outside the corpus. It is a required floor check, not a representative sample.
_Avoid_: optional test, sample case, corpus entry

**Preflight**:
The cheap viability check before the compatibility gate. It confirms the candidate loads, meets its runtime contract, and can propose a successor through a sanctioned path.
_Avoid_: validation gate, quality evaluation

**Inconclusive**:
An evaluation outcome where the system cannot determine pass or fail. It describes insufficient or invalid evidence, not a regression.
_Avoid_: failure, pass, ignored result
