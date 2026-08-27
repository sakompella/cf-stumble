# Keep config as a typed record in the manifest, with no code generation

An agent definition's config is a validated, versioned, typed record stored as a blob in the manifest tree and read directly at materialization. Code generation was considered and rejected: this system already treats the agent's code as data, so generating code from that data adds a build stage that can fail between a validated generation and a running one, which is exactly the gap the generation model exists to close.
