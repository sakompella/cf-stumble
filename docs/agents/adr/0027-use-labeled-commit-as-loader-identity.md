# Use the labeled harness commit as Worker Loader identity

> **Review:** Human-approved

A generation is a labeled harness commit, and that commit ID is the Worker Loader identity for the generation. A changed harness commit receives a different Loader name; repeated use of the same labeled commit intentionally reuses its Loader entry. Do not add a separate artifact digest or mount key. This decision does not select a bundle or module-map encoding, artifact storage, retention, or the Dynamic Worker Loader payload.
