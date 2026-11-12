# Use the labeled harness commit as Worker Loader identity

> **Review:** Human-approved

A generation is a labeled harness commit, and that commit ID is the Worker Loader identity for the generation. A changed harness commit receives a different Loader name; repeated use of the same labeled commit intentionally reuses its Loader entry. Do not add a separate artifact digest or mount key.

The Loader keeps a Worker's `env` with its entry, so the Supervisor loads a generation with an empty `env`: the entry holds nothing that depends on the Supervisor or the serving instance. The model capability is bound to one serving instance, so the Supervisor passes it as an argument of the facet's `attach`, beside the host and the generation control, and the facet keeps it in its open session. A new serving instance still gets a new facet object: activation and rollback abort the serving facet, and the next mount attaches the new instance's host, generation control and model capability. A capability from a replaced instance is still refused by the Model Route. A rollback to a commit that served before therefore reuses that commit's Loader entry and gets the current instance's capability. The serving facet keeps one storage name (`main-facet:serving`) across generations.

The startup check loads its candidate under the same commit name and passes its scripted model through `attach` in the same way, so a candidate never holds the production model. The candidate runs in its own facet, `main-facet:candidate:<commit>`, with its own storage. This decision does not select a bundle or module-map encoding, artifact storage, retention, or the Dynamic Worker Loader payload.

Generations built before this change (facet compatibility `host-5`) read the model from `env.MODEL` and take `attach(host, generations)`. Until none of them serves, `src/supervisor/artifacts/old-protocol.ts` loads such a generation the old way, under `<commit>:serving:<instance>` with the model in its `env`, but only when it is the active generation or the startup check's writer. Activation and rollback still require the current key, so no `host-5` generation can be activated again.
