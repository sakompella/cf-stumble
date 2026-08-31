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
A specific, labeled Git commit in the harness repository. The Supervisor records preparation checks, activation, and recovery evidence against it.
_Avoid_: ordinary commit, revision, version

**Generation 0**:
The first labeled mutable main-harness commit, initially based closely on Pi. It is neither the recovery harness nor a special recovery target.

**Active generation**:
The generation currently selected and running as the main harness.

**Last active generation**:
The generation that most recently ran as the main harness when no generation is currently active.

**Known-good generation**:
A generation for which the supervisor has enough evidence to consider it a safe recovery target. The required evidence and threshold remain open.

**Probation**:
A period in which a generation may run but has not yet gathered enough evidence to become known good.

**Real turn**:
A user interaction that may contribute evidence about a generation. A successful HTTP status alone does not prove that a streamed interaction completed.

**Relay attempt**:
The Supervisor's durable record of one forwarded request, including its generation attribution, response status, and terminal outcome. Eligibility derives from terminal relay attempts in the current evidence era.

**Recovery report**:
The supervisor's durable record of a recovery attempt, its error, and its result.

## Repositories and files

**Commit**:
An ordinary Git commit in any repository. A harness commit becomes a generation only when the Supervisor gives that specific commit a generation label; a project commit never does so automatically.
_Avoid_: generation

**Harness repository**:
A Git repository containing main-harness source. It is logically separate from repositories used for the user's other work.

**Project repository**:
A Git repository used for a piece of user work. GitHub is the first planned remote integration, not part of the definition.

**Computer workspace**:
A durable filesystem provided by `@cloudflare/computer`. A cf-stumble instance may use one or several Computer workspaces; the mapping between workspaces, projects, harness source, sessions, and accumulated context remains open.

**Accumulated context**:
Session history and other useful context that can survive a change of main-harness generation. Its storage layout remains open.

**Worker-shell**:
Computer's text-oriented execution backend, including host-forwarded Git.

**Container backend**:
Computer's Linux process backend for Node, package managers, builds, tests, and project commands.

## Generation requests

**Generation candidate submission**:
A request for the supervisor to create and check a generation from a particular main-harness revision. Submission does not guarantee activation.

**Generation activation request**:
A request to make a specific existing generation active. The requester may name the target, but the supervisor checks and performs or rejects the change.
