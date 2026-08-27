# Keep config as a typed record in the manifest, with no code generation

An agent definition's config is a validated, versioned, typed record stored as a blob in the manifest tree and read directly at materialization. We rejected code generation. This system already treats agent code as data, so generating code from it adds a build stage that can fail between a validated generation and a running one. The generation model exists to close that gap.
