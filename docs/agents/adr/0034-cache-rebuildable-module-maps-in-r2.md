# Cache rebuildable module maps in R2

> **Superseded for v0:** Handoff decision 6 replaces this R2 cache decision with Supervisor SQLite module-map storage.

> **Review:** Human-approved

A labeled harness commit is the authoritative description of a generation's executable code. For now, cf-stumble assumes that rebuilding one labeled commit through Computer produces the same module map each time.

The Supervisor must not retain completed module maps in Durable Object SQLite. It may read and write an evictable R2 cache keyed by the labeled harness commit. A cache miss asks Computer to rebuild the module map from that commit. The Supervisor then validates the rebuilt map and loads it through the Worker Loader under the same commit identity.

R2 stores derived build output to reduce Computer work. It does not decide which code may serve, and losing an R2 object must not make generation state invalid. The next request rebuilds the map. Evicting an unused object is therefore safe.

This decision does not add a digest, mount key, or second artifact identity. The cache key derives from the labeled harness commit, as ADR-0027 requires. Cache reads, writes, misses, and eviction do not advance the generation-control epoch because activation and rollback do not use them as decision inputs.

Supervisor SQLite no longer stores module source, and a schema test checks that. One resolver reads the R2 cache and rebuilds the labeled commit on a miss or a corrupt object. The cache budget, eviction rule, Computer build command, cold-request behavior, and paid-runtime evidence remain open. Two local builds of one commit produce the same canonical map, but a real Computer build has not been measured yet.
