# Represent an executable generation as a module map

> **Review:** Agent-only

The executable form of a generation is a module map: named Worker modules plus the name of the entry module. A single-file bundle is expressed as a one-module map rather than as a second shape.

The alternative was to make a bundle the artifact and treat a module map as a later extension. That would have given loading, validation, and retention two shapes to handle for as long as both existed, and it would have collapsed the Worker module boundaries that a future generation may want to keep.

ADR-0027 already fixes the Worker Loader identity as the labeled harness commit and forbids a separate artifact digest or mount key. This decision defines the executable shape, not where the project caches it. ADR-0034 selects an evictable R2 cache for rebuildable module maps and removes completed module maps from the Supervisor's intended durable state.

How TypeScript harness source becomes modules, the cache budget, the eviction rule, and the Computer build path remain open.
