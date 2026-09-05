# Treat the shared workspace as a development machine

> **Review:** Human-approved

The owner's Computer workspace has unrestricted outbound internet access and the normal development
tools needed by the connected repositories. Version 0 makes `git` and `gh` available; Pi may also
use package managers, `curl`, and other installed command-line tools when the work requires them.
No separate installation step is needed when the Computer image or repository toolchain already
provides a tool. cf-stumble does not add an egress allowlist or require every change to use a pull
request. The agent may push directly or open a pull request according to the user's request,
repository permissions, and repository conventions. `git` and `gh` call GitHub directly; the
Supervisor does not proxy each GitHub operation through its own API.

The user signs in with GitHub through Cloudflare Access. That sign-in establishes cf-stumble
identity; connecting a project uses a separate GitHub authorization to grant repository access. The
workspace stores the resulting GitHub credential in the normal local `gh` configuration outside
the connected repositories. The credential must not appear in a tracked file, browser response, or
application log. Version 0 accepts the ordinary risk of giving a coding agent shell access,
internet access, development credentials, and every repository in the shared workspace; broader
workstation hardening is deferred.

The managed Pi `AGENTS.md` includes this instruction:

> `git`, `gh`, and internet access are available. Use them as needed, following the user's request
> and the repository's conventions. Never print or commit authentication tokens.
