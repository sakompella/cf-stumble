# Represent an executable generation as a module map

> **Review:** Agent-only

The executable form of a generation is a module map: named Worker modules plus the name of the entry module. A single-file bundle is expressed as a one-module map rather than as a second shape.

The alternative was to make a bundle the artifact and treat a module map as a later extension. That would have given loading, validation, and retention two shapes to handle for as long as both existed, and it would have collapsed the Worker module boundaries that a future generation may want to keep.

ADR-0027 already fixes the Worker Loader identity as the labeled harness commit and forbids a separate artifact digest or mount key. This decision defines the executable shape, not where the Supervisor keeps it. The Supervisor stores the canonical encoding of that shape in its own SQLite, split into byte chunks that one transaction writes together, so activating or rolling back to a generation that is already ready loads stored code and never asks Computer for another build.

How TypeScript harness source becomes modules, and the Computer build path, remain open.
