# Isolate agent code behind four capabilities

Agent-controlled code runs in an isolated facet while the supervisor remains deployed, trusted, and outside the agent's control. The agent action space is permanently limited to `read`, `write`, `edit`, and `bash`; a facet must never receive a general `@cloudflare/computer` Workspace, because that also exposes broad filesystem, git, Assets, and Artifacts capabilities. This gives the boundary a small capability surface that can be audited instead of treating a whole workspace as harmless.
