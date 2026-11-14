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
A user interaction. A successful HTTP status alone does not prove that a streamed interaction completed.

**Run**:
The work Pi Durable does on a project's conversation from a submitted message until it settles. A run
outlives the browser that sent the message. Each run has its own deadline, 8 minutes after the facet
reports its conversation running (or after a newly activated generation takes the run over), and
the Supervisor aborts the run when that deadline passes.
A run that the deadline aborts, or whose reply the model's output length limit cuts off, ends with a
run notice: a harness entry in the conversation that says what happened and that a message continues
the run. The model reads it on the next turn, and the owner page shows it
(`src/facet/generation-1/run-notices.ts`). An owner cancel leaves no notice.

**Run budget**:
The time the owner gives one message, chosen in the page composer: 8, 30 or 60 minutes, 30 by
default. When the deadline aborts a run that got at least one model reply, and another 8-minute run
still fits in the budget, the facet submits the run notice as a new message, which starts the next
run at once; the notice then says how many of the budget's minutes are used. This is an auto-continue.
With 30 minutes a message gets up to three runs, with 60 up to seven. When the budget is spent, or
the run got no reply, the notice asks for a message as before. A cancel stops the chain, and a new
owner message starts its own budget (`src/facet/generation-1/run-budget.ts`).

## Repositories and files

**Commit**:
An ordinary Git commit in any repository. A harness commit becomes a generation only when the Supervisor gives that specific commit a generation label; a project commit never does so automatically.
_Avoid_: generation

**Harness repository**:
A Git repository containing main-harness source. It is logically separate from repositories used for the user's other work.

**Project repository**:
A Git repository used for a piece of user work. In version 0, each project is a GitHub repository
that the user connected to cf-stumble.

**Project thread**:
The current Pi Durable conversation for one project. Starting a fresh thread replaces its conversation and
compacted context but preserves every repository in the Computer workspace. Version 0 presents one
current thread per project.

**Computer workspace**:
A durable filesystem and command environment provided by `@cloudflare/computer`. Version 0 uses one
workspace for the owner's harness repository and connected project repositories. Each repository
has its own directory and Git history, but the directories are not security boundaries.

**Accumulated context**:
Conversation history, compacted context, and other useful context that can survive a change of
main-harness generation.

**Worker-shell**:
Computer's text-oriented execution backend. It has no Git; every `git` command runs in the container backend.

**Container backend**:
Computer's Linux process backend for Git, Node, package managers, builds, tests, and project commands.

## Generation requests

**Generation candidate submission**:
A request for the supervisor to create and check a generation from a particular main-harness revision. Submission does not guarantee activation.

**Generation activation request**:
A request to make a specific existing generation active. The requester may name the target, but the supervisor checks and performs or rejects the change.

**Startup check**:
The supervisor's check of a prepared generation before it may become ready. The candidate runs in isolation and must report the supervisor's facet compatibility and answer one scripted conversation that runs one workspace command. A failed check marks the generation failed and leaves the active generation serving.

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
Single-owner version 1 works: the owner can use one connected project, reload the browser without losing accepted work, cancel a run, try and undo a harness change, deploy and recover from a failed update, and stop paying for the container when work ends. It does not include public access, guests, teams or isolation between projects. The multi-person service in the README is a long-term aspiration, not part of done. See `status.md`, "What done means".
_Avoid_: complete, production-ready for several users
