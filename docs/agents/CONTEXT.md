# cf-stumble

cf-stumble is a personal agent with a mutable main harness, built for one owner. This glossary names concepts that must remain distinct; implementation choices belong in design documents and ADRs.

## Harness and execution

**Main harness**:
The mutable agent harness that performs the user's work. A generation supplies one version of it.
_Avoid_: supervisor

**Supervisor Durable Object**:
The primary Durable Object for a cf-stumble instance. It manages main-harness facets, protects generation state, and decides whether requested generation changes may occur. It is not a facet.
_Avoid_: main facet, workspace

**Main facet**:
A Dynamic Worker facet that runs one generation of the main harness.
_Avoid_: supervisor

**Generation**:
A specific, labeled Git commit in the harness repository. The Supervisor records preparation checks and activation against it.
_Avoid_: ordinary commit, revision, version

**Active generation**:
The generation currently selected and running as the main harness.

**Real turn**:
A run on an owner's message, as opposed to the startup check's scripted conversation. Only a run that
settles completed is evidence; a 202 or an open stream is not.

**Probation**:
The state of a newly activated generation until a real turn on it completes. If a run fails because of
the generation, or stalls before its first model turn, the Supervisor rolls back to the last generation
that completed a real turn (`src/supervisor/generation-machine.ts`). A cancel, a model error or a long
run neither proves nor fails it.

**Run**:
The work Pi Durable does on a project's conversation from a submitted message until it settles. A run
outlives the browser that sent the message. Each run has its own deadline, 8 minutes after the facet
reports its conversation running (or after a newly activated generation takes the run over), and
the Supervisor aborts the run when that deadline passes.
A run that the deadline aborts, or whose reply the model's output length limit cuts off, ends with a
run notice: a harness entry in the conversation that says what happened and that a message continues
the run. The model reads it on the next turn, and the owner page shows it
(`src/facet/generation-1/run-notices.ts`). An owner cancel leaves no notice. A cancel that reaches the Supervisor before the facet's first
running report for the conversation is stored, and the run that the next report starts settles as
cancelled.

**Run phase**:
What the owner page shows beside a run's status while the run works, folded from Pi Durable's live
document: `Idle`, `Preparing`, `Compacting`, `WaitingForModel` or `Working`
(`src/conversation-view/run-phase.ts`). `Preparing` is the wait for the workspace before the model is
asked, and a cold container start is one cause of it.

**Run budget**:
The time the owner gives one message, chosen in the page composer: 8, 30 or 60 minutes, 30 by
default. When the deadline aborts a run that got at least one model reply, and another 8-minute run
still fits in the budget, the facet submits the run notice as a new message, which starts the next
run at once; the notice then says how many of the budget's minutes are used. This is an auto-continue.
With 30 minutes a message gets up to three runs, with 60 up to seven. When the budget is spent, or
the run got no reply, the notice asks for a message as before. A cancel clears the budget before it
aborts the run, so no deadline abort continues the run after a cancel, and a resend of the same
message does not bring the budget back. A new owner message starts its own budget (`src/facet/generation-1/run-budget.ts`).

**Serving instance**:
The number of the facet that serves the active generation. The Supervisor adds one each time an
activation or rollback replaces the facet, and stores it with the active label in
`generation_state.serving_instance`, so one transaction moves both. A facet's model turns and run
reports count only while its instance is the serving one, so a mount that finished after a
replacement cannot act with the new facet's authority.

**Thread replaced**:
The refusal `thread-replaced` (HTTP 409). Each message the page posts names the conversation it was
written for. When a fresh thread has replaced that conversation, the Supervisor refuses the message
and the page puts its text back in the prompt, so a retry never reaches the new thread.

## Repositories and files

**Commit**:
An ordinary Git commit in any repository. A harness commit becomes a generation only when the Supervisor gives that specific commit a generation label; a project commit never does so automatically.
_Avoid_: generation

**Harness repository**:
A Git repository containing main-harness source. It is logically separate from repositories used for the user's other work.

**Project repository**:
A Git repository used for a piece of user work: a GitHub repository that the owner connected to
cf-stumble.

**Project thread**:
The current Pi Durable conversation for one project. Starting a fresh thread replaces its conversation and
compacted context but preserves every repository in the Computer workspace. A project has one
current thread.

**Computer workspace**:
A durable filesystem and command environment provided by `@cloudflare/computer`. One workspace holds
the owner's harness repository and every connected project repository. Each repository
has its own directory and Git history, but the directories are not security boundaries.

**Accumulated context**:
Conversation history, compacted context, and other useful context that can survive a change of
main-harness generation.

**Workspace Host**:
The Durable Object that owns the Computer workspace and its container (`WorkspaceHost`). It counts
work, stops the container after ten minutes with none (ADR-0043), and answers the Supervisor's build,
provision, credential and project calls. It runs the container on Cloudflare, or on a provider machine
of Aditya's when one is connected and selected (ADR-0050).

**Isolate backend**:
Computer's Worker-shell backend, a shell in a Dynamic Worker. A `bash` call runs there when the
isolate can run every program in it, and in the container otherwise or when the model asks for the
container. It has no Git; every `git` command runs in the container (ADR-0052).

**Container backend**:
Computer's Linux container backend for Git, Node, package managers, builds, tests, and project commands.

## Generation requests

**Generation candidate submission**:
A request for the supervisor to create and check a generation from a particular main-harness revision. Submission does not guarantee activation.

**Generation activation request**:
A request to make a specific existing generation active. The requester may name the target, but the supervisor checks and performs or rejects the change.

**Startup check**:
The Supervisor's check of a prepared generation before it may become ready. The candidate runs in its own facet with a scripted model. It must report the Supervisor's facet compatibility and complete the scripted conversation: commands on the isolate and the container, `stumble gen status`, and a write, edit and read of a scratch file (`src/startup-check-model.ts`). A failed check marks the generation failed and leaves the active generation serving.

**Release**:
The step of the Deploy workflow that, after a production deploy, submits `main`'s commit as a
generation and activates it (`tools/release-generation.mts`; `docs/deploy.md`, "Release of main as a
generation"). The release owns the repeat after an infrastructure interruption, under one recovery
deadline of 10 minutes (`INTERRUPTION_DEADLINE_MS`).

**Infrastructure interruption**:
A platform reset or fault that ends a Durable Object's work, such as a deploy's restart or a cold
Workspace Host that fails to start its storage, as opposed to a candidate that is wrong. The
Supervisor's build reports it as `build-workspace-unavailable` (the Host also logs
`workspace-restarted` when the platform marked the failure retryable), and the Worker answers a
rejected submit or prepare call as 503 `infrastructure-interrupted`. Both mean the same commit can
be prepared again. A failed build step or a failed startup check is not an interruption and is not
repeated.

**Self-activation**:
The main harness activating a generation from its own conversation with `stumble gen activate`. The serving facet ends, and the conversation resumes under the new generation.
_Avoid_: self-deploy

## Authority and scope

**Owner**:
The one person who uses a cf-stumble instance. The owner holds the `OWNER_PASSWORD` Basic credential, the GitHub credential in the workspace and the ChatGPT connection, and decides which harness changes stay. The product has no other kind of user.
_Avoid_: tenant, team member, guest

**Owner-approved harness**:
A main-harness generation that the owner submitted and activated, or that the owner's own conversation submitted and activated with `stumble gen`. The Supervisor checks compatibility and a scripted tool sequence, not intent or quality.

**Authority boundary**:
The statement of who is trusted: the owner and an owner-approved harness, on one shared development machine, with no isolation between repositories. It is not a boundary between projects or against a guest. The boundary that does hold is between the immutable host and the harness: a facet receives capabilities, not account secrets. See `design/overview.md`, "Who is trusted".
_Avoid_: sandbox, multi-tenant isolation

**Done**:
Single-owner version 1 works: the owner can use one connected project for real work, reload the browser without losing accepted work, cancel a run, activate a harness change and roll it back, stop or restart the container without silently losing an acknowledged write, deploy and recover from a failed update, and stop paying for the container when work ends. It does not include public access, guests, teams, isolation between projects, owner-selected models or a cap on the account's bill. The multi-person service in the README is a long-term aspiration, not part of done.
_Avoid_: complete, production-ready for several users
