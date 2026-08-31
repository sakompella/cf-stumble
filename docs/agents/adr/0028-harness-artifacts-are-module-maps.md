# Represent an executable generation as a module map

> **Review:** Agent-only

The executable form of a generation is a module map: named Worker modules plus the name of the entry module. A single-file bundle is expressed as a one-module map rather than as a second shape.

The alternative was to make a bundle the artifact and treat a module map as a later extension. That would have given loading, validation, and retention two shapes to handle for as long as both existed, and it would have collapsed the Worker module boundaries that a future generation may want to keep.

ADR-0027 already fixes the Worker Loader identity as the labeled harness commit and forbids a separate artifact digest or mount key. The Supervisor stores each module map in its Durable Object SQLite database under that commit. It records the first valid map it sees and rejects different bytes for the same commit before the Worker Loader can cache them. The Supervisor probes that stored map during the startup check, then resolves the active generation to the same map for every normal request. This lets a cold Supervisor reload the active main facet without adding another identity or changing the generation-control epoch.

The local artifact store does not prune module maps. How TypeScript harness source becomes those modules, how a deployed system limits storage, and when it deletes unneeded artifacts remain open.
