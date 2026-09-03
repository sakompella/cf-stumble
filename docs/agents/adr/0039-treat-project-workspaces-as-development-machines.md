# Treat project workspaces as development machines

> **Review:** Human-approved

A project Computer workspace has unrestricted outbound internet access and the normal development
tools needed by the repository. Version 0 ships `git` and `gh`; Pi may also use package managers,
`curl`, and other installed command-line tools when the work requires them. cf-stumble does not add
an egress allowlist, a GitHub capability layer, or a product-level rule that every change must use a
pull request.

The user signs in with GitHub through Cloudflare Access. That sign-in establishes cf-stumble
identity; connecting a project uses a separate GitHub authorization to grant repository access. The
workspace stores the resulting GitHub credential in the normal local `gh` configuration outside the
project repository. The credential must not appear in a tracked file, browser response, or
application log. Version 0 accepts the ordinary risk of giving a coding agent shell access,
internet access, and development credentials; broader workstation hardening is deferred.

The managed Pi `AGENTS.md` includes this instruction:

> `git`, `gh`, and internet access are available. Use them as needed, following the user's request
> and the repository's conventions. Never print or commit authentication tokens.
