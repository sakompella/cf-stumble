# cf-stumble

cf-stumble is a personal agent with a mutable main harness. This glossary names concepts that must remain distinct; implementation choices belong in design documents and ADRs.

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
reports its conversation running, and the Supervisor aborts the run when that deadline passes.

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
