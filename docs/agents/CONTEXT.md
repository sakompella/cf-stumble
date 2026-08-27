# cf-stumble

cf-stumble is a self-modifying agent harness: the agent can revise its own definition, but a separate authority decides which revisions may run. This glossary fixes the project-specific language needed to keep authored history, attempted executions, and live operation distinct.

## Language

### History and identity

**Commit**:
An ordinary Git revision in the agent's authored history. It is not a generation, an attempt, or evidence that anything has run.
_Avoid_: generation, release, deployment

**Authored history**:
The commit DAG containing the agent definition's revisions and their ancestry. It is Git history, not the history of which generations were live.
_Avoid_: generation history, activation history

**Working tree**:
A mutable checkout used to assemble an ordinary commit. In the Git analogy it is scratch space, not an immutable revision or a generation.
_Avoid_: generation, snapshot

**Generation**:
One attempted facet materialization of a particular commit, identified by a never-reused number. It resembles a NixOS generation in being a numbered attempt, but it is an agent attempt rather than a bootable operating system.
_Avoid_: commit, snapshot, version, revision

**Generation registry**:
The authoritative catalogue of generations and their materialization records. It is not Git tags: tags name revisions, while the registry identifies attempts.
_Avoid_: tags, generation refs, generation list

**Generation 0 (genesis)**:
The known-good initial generation and the guaranteed recovery target. It resembles a NixOS fallback generation, but is a project recovery point rather than an operating-system boot entry.
_Avoid_: root commit, default branch, initial commit

**Candidate**:
A generation being considered for activation. It is a role a generation plays before its first promotion, not a separate kind of content.
_Avoid_: draft, proposed commit, untrusted commit

**Baseline**:
The live generation against which a candidate is evaluated. It records the relevant operational starting point, not the candidate's commit parent.
_Avoid_: parent, predecessor, previous commit

**Artifact**:
The concrete agent definition loaded for one materialization attempt. It is evidence of what ran, rather than merely the commit that was selected.
_Avoid_: commit, source, build output

### Attempts and activation

**Materialization**:
The outcome of one attempt to turn a commit into a running facet. It says what was tried and whether it became usable; it does not say whether it was ever live.
_Avoid_: activation, deployment, promotion

**Activation**:
An event that makes one generation live. A generation may be activated more than once, so activation is distinct from its one materialization attempt.
_Avoid_: materialization, generation status, deployment

**Activation ledger**:
The ordered history of activation events. It answers when a generation was live, while the registry answers what generation was attempted.
_Avoid_: generation history, status history, changelog

**Live pointer**:
The current activation's generation number. It identifies an attempted materialization, not merely a commit.
_Avoid_: live branch, current commit, active ref

**Promotion**:
An activation that makes a validated candidate live. It is a decision about an attempted generation, not a Git operation.
_Avoid_: merge, deploy, publish

**Rollback**:
An activation that returns to a generation that was live before. It is not time travel through authored history and does not erase later activations.
_Avoid_: undo, revert, reset

**Reset**:
The recovery activation that returns directly to genesis. Unlike rollback, it remains available even when ordinary recovery rules no longer permit a target.
_Avoid_: rollback, revert, restart

**Quarantine**:
A restriction that prevents a particular generation from becoming live again through ordinary activation. It names a known-bad attempt, not a bad commit in every possible context.
_Avoid_: blacklist, ban, rejected commit

**Attestation**:
The supervisor's validation evidence for a particular candidate, baseline, artifact, and evaluation context. It is proof tied to one reality, not a caller-supplied approval.
_Avoid_: approval token, validation token, certificate

### The agent boundary

**Supervisor**:
The trusted authority outside the agent definition that governs generations and activation. It is not agent-authored code and does not become a candidate.
_Avoid_: agent, facet, controller

**Facet**:
The isolated execution compartment in which one generation's agent code runs. It is the subject of a materialization attempt, not the generation record for that attempt.
_Avoid_: generation, sandbox, worker

**Facet capability**:
Authority available to the active harness for ordinary work, including its tool registry, runtime, and workspace. It may evolve with the agent definition; it excludes direct authority over supervisor recovery state.
_Avoid_: supervisor access, recovery authority

**Agent workspace**:
The facet-owned mutable work environment used for tasks and harness development. It may be backed by a Computer Workspace, but it is ordinary agent state rather than supervisor recovery state.
_Avoid_: supervisor workspace, recovery store

**Computer Workspace**:
The platform workspace supplied by `@cloudflare/computer`, which may implement an agent workspace. Use the qualifier when referring specifically to that API rather than to the domain concept.
_Avoid_: workspace (when the platform API is meant)

**Four primitives**:
The agent action set generation 0 ships with: `read`, `write`, `edit`, and `bash`. They are the bootstrap tool registry, not a permanent ceiling — a later agent definition may extend its own tool registry, since the facet's harness is meant to evolve.
_Avoid_: fixed action space, permanent capabilities

**Agent definition**:
The versioned material that describes how the agent behaves, including its model loop, tool registry, prompt, policy, skills, and agent-authored modules. It excludes the supervisor and accumulated context.
_Avoid_: agent state, supervisor configuration, runtime state

**Prompt, policy, and skills**:
Parts of an agent definition: the prompt directs the model, policy states constraints, and skills provide reusable task guidance. They evolve alongside the model loop, tool registry, and other harness modules.
_Avoid_: runtime state, accumulated context

**Accumulated context**:
Knowledge and history that persist across generations without becoming part of an agent definition. Rollback does not rewind it.
_Avoid_: generation state, commit state, snapshot state

### Evaluation and execution

**Turn**:
One interaction with the agent from input through result. A turn is an operational unit, not a commit or a generation attempt.
_Avoid_: session, generation, task

**Turn pinning**:
The rule that a turn uses the live generation selected at its start for its entire duration. It protects one interaction from an activation that happens partway through.
_Avoid_: live reload, mid-turn migration

**Executor**:
The component of an agent definition that turns model responses into tool calls and effects. The gate evaluates the candidate's executor, so validation concerns the behavior that would actually run.
_Avoid_: model, facet, individual tool

**Replay session**:
A recorded interaction used to reproduce a defined sequence of model responses, primitive calls, and observable effects. It is a compatibility case, not a fresh evaluation of whether a prompt is better.
_Avoid_: benchmark, quality trial, live trial

**Compatibility corpus**:
The set of replay sessions used to check that a candidate preserves established executor behavior. It is not a general measure of agent quality.
_Avoid_: quality benchmark, validation corpus, training set

**Validation gate**:
The acceptance process that evaluates a candidate before promotion. It provides a compatibility floor, not a claim that the candidate improved the agent.
_Avoid_: quality gate, evaluator, promotion

**Ratchet**:
The gate rule that a candidate must not turn a baseline success into a failure. It preserves a floor of known behavior without treating existing failures as new regressions.
_Avoid_: score, quality metric, benchmark

**Canary**:
A compatibility case that must pass in its own right and whose identity is protected independently of the rest of the corpus. It is a mandatory floor check, not a representative sample.
_Avoid_: optional test, sample case, corpus entry

**Preflight**:
The cheap viability check before the compatibility gate. It confirms that a candidate loads, satisfies its declared runtime contract, and can still propose a future candidate through a sanctioned path.
_Avoid_: validation gate, quality evaluation

**Inconclusive**:
An evaluation outcome meaning the system could not determine pass or fail. It is distinct from failure because it describes insufficient or invalid evidence, not a demonstrated regression.
_Avoid_: failure, pass, ignored result
