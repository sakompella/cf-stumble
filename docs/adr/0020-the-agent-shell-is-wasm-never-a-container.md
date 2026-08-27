# Give the agent a WebAssembly shell, never a container

The `bash` primitive is a shell over the capability filesystem with JavaScript and Python interpreters compiled to WebAssembly. It creates no OS processes, runs no compiler, and installs no packages. A container would give the agent a real Linux environment and is the only way to run something like `pnpm test`, but it carries a much larger capability surface, image and environment credential risk, and cold-start cost — so if native execution is ever needed it goes behind a separately authenticated, supervisor-owned validator, never behind the facet's shell.

## Consequences

The agent cannot run this repository's own test suite, which is the first thing a reader will try to do and the first question they will ask. Validation of a candidate is the supervisor's job through the gate (ADR-0005, ADR-0006), not something the agent performs on itself. The specific WebAssembly shell is part of the migration ADR-0010 proposes; the prohibition on putting a container behind the facet holds either way.
