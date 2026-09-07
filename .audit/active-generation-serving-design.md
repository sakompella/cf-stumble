# Active-generation serving design

The selected design adds a Supervisor-owned `HarnessArtifacts` store. It retains an immutable module map under the existing labeled harness commit. Each module has one durable row. A partial unique index marks the only entry module.

The store canonicalizes artifact bytes before calling `WorkerLoader`. A startup check inserts the first map for a commit or verifies that a retry has the same map. It then reloads the canonical map from SQLite and probes that map. A passing probe records the generation as ready. A failed probe leaves the generation unable to serve. A new commit is required to change bytes.

The Supervisor constructor resolves the active generation to its retained artifact and mounts the corresponding serving facet. Generation 0 receives the fixture module map when the artifact store initializes. When no generation is active, the Supervisor still mounts the fixture. A ready active generation without retained bytes relays a mount failure rather than throwing.

The store never creates a second loader identity. It does not change the epoch. The Supervisor alone writes artifact rows. Relay and recovery code stays unchanged.

## Arena synthesis

Claude Opus supplied the base design. GPT Sol identified one required graft. Retention must happen before any `WorkerLoader` call because the loader caches by commit. The canonical stored map must be the map that startup probes. Sol also required idempotent fixture retention for Generation 0.

The four initial Arena candidates did not return a bounded design package before the time-boxed Opus and Sol decision. Their late output did not change the selected design.

Rejected alternatives:

- A digest, mount key, or activation artifact ID would create the second identity ADR-0027 forbids.
- An in-memory module map would disappear on Durable Object eviction.
- A JSON blob would hide the module-map and entry-module invariants in runtime parsing.
- Retaining bytes only after a successful probe would let concurrent or repeated checks validate bytes that differ from the stored map.
