# cf-stumble

cf-stumble is a personal agent whose mutable main harness is kept separate from its immutable recovery harness. This glossary names concepts that must remain distinct; implementation choices belong in design documents and ADRs.

## Harness and execution

**Main harness**:
The mutable agent harness that performs the user's work. A generation supplies one version of it.
_Avoid_: supervisor, recovery harness

**Recovery harness**:
The immutable, Pi-derived agent code that diagnoses failures and restores a usable main harness. It stays close to the Pi base but omits the main harness's connector for requesting Supervisor capabilities. It runs in the Supervisor Durable Object but is not itself a generation.
_Avoid_: Generation 0, main harness

**Supervisor Durable Object**:
The primary Durable Object for a cf-stumble instance. It contains the recovery harness, manages main-harness facets, protects generation state, and decides whether requested generation changes may occur. It is not a facet.
_Avoid_: main facet, workspace

**Main facet**:
A Dynamic Worker facet that runs one generation of the main harness.
_Avoid_: supervisor, recovery harness

**Generation**:
A specific, labeled Git commit in the harness repository. The Supervisor records preparation checks and activation against it.
_Avoid_: ordinary commit, revision, version

**Generation 0**:
The first labeled mutable main-harness commit, initially based closely on Pi. It is neither the recovery harness nor a special recovery target.

**Active generation**:
The generation currently selected and running as the main harness.

**Last active generation**:
The generation that most recently ran as the main harness when no generation is currently active.

**Real turn**:
A user interaction. A successful HTTP status alone does not prove that a streamed interaction completed.

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
The current Pi conversation for one project. Starting a fresh thread replaces its conversation and
compacted context but preserves every repository in the Computer workspace. Version 0 presents one
current thread per project.

**Computer workspace**:
A durable filesystem and command environment provided by `@cloudflare/computer`. Version 0 uses one
workspace for the owner's harness repository and connected project repositories. Each repository
has its own directory and Git history, but the directories are not security boundaries.

**Accumulated context**:
Pi thread history, compacted context, and other useful context that can survive a change of
main-harness generation. Its storage layout remains open.

**Worker-shell**:
Computer's text-oriented execution backend, including host-forwarded Git.

**Container backend**:
Computer's Linux process backend for Node, package managers, builds, tests, and project commands.

## Generation requests

**Generation candidate submission**:
A request for the supervisor to create and check a generation from a particular main-harness revision. Submission does not guarantee activation.

**Generation activation request**:
A request to make a specific existing generation active. The requester may name the target, but the supervisor checks and performs or rejects the change.
