# Use the labeled harness commit as Worker Loader identity

> **Review:** Human-approved

A generation is a labeled harness commit, and that commit ID is the Worker Loader identity for the generation. A changed harness commit receives a different Loader name; repeated use of the same labeled commit intentionally reuses its Loader entry. Do not add a separate artifact digest or mount key.

The serving Loader name also carries the Supervisor's serving instance (`<commit>:serving:<instance>`). The Loader keeps a Worker's `env` with its entry, and the model capability in that `env` is bound to one serving instance. After a rollback to a commit that served before, the old entry would hold a capability for a replaced instance, and the Model Route would refuse every model turn. The instance changes on every activation and rollback, so each one loads the stored module map again under a new name. The startup check names its candidate Loader entry by commit alone, because its model capability has no instance. This decision does not select a bundle or module-map encoding, artifact storage, retention, or the Dynamic Worker Loader payload.
