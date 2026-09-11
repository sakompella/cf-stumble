# Connecting GitHub repositories

This document describes how cf-stumble connects a GitHub repository to the owner's tenant, where
the GitHub credential lives, and which credential source an automated run uses. ADR-0038 and
ADR-0039 are the decisions behind it: one shared Computer workspace per tenant, and repository
authorization that is separate from Cloudflare Access.

## Two different permissions

Cloudflare Access proves who the caller is. It grants no access to any repository. A caller who
passes Access reaches their own Supervisor and nothing on GitHub. Repository access comes from a
GitHub credential that lives in the workspace, in the normal local `gh` configuration.

## The connected project list

`src/project-catalog.ts` defines a project as an id, a display name, and a public repository URL.
The catalog is a variable-length collection, and the tenant's copy lives in the Supervisor's
SQLite table `connected_projects` (`src/supervisor/projects/connected-projects.ts`). A deployment
starts with no projects.

A project's id comes from its canonical repository URL, never from a counter or a position in the
list. `https://GitHub.com/Owner/Repo.git`, `https://github.com/Owner/Repo`, and the same URL with a
trailing slash all reduce to `https://github.com/Owner/Repo`, and that reduces to the project id
`owner-repo`. Two consequences follow. Connecting the same repository twice converges on the
project that is already there instead of creating a second one. Renaming a project or connecting a
third repository changes no other project's id, so threads and directories stay where they were.

If two different repositories reduce to one id, cf-stumble refuses the second connection with
`project-id-conflict`. It does not repoint an existing project at a different clone, because the
project's thread and files belong to the first repository.

## Connecting a repository

`Supervisor.connectProject` performs these steps in order:

1. Make the workspace credential usable, if that is possible without a person. A working
   credential is left alone.
2. Ask the workspace whether the repository is readable, by running `git ls-remote` through the
   credential helper that `gh auth setup-git` configured. This is the same path a clone takes.
3. Record the project in `connected_projects`.
4. Provision the project: reconcile its clone inside the tenant's one workspace and rewrite the
   managed instructions file.

If the clone fails, cf-stumble removes a project it has just recorded. A project in the list is a
project whose repository is in the workspace. Provisioning also runs when a project is used, so a
workspace that the platform recreated is repaired on the next turn rather than reported as broken.

## The owner authorization

Version 0 uses GitHub's OAuth device flow, which is question Q2's default. The Supervisor asks
GitHub for a device code, and the page shows only the verification URL and the short user code. The
owner signs in at that page. The Supervisor then redeems the authorization and installs the token
into the workspace.

Three rules protect the flow:

- The pending authorization records the verified Access identity and audience that started it. A
  redemption presented by any other verified owner is refused.
- The device code is deleted when it is redeemed, denied, or expires, so the same request replayed
  finds nothing to redeem.
- Every state-changing project route refuses a request whose `Origin` header is not cf-stumble's
  own origin.

The live owner-run authorization is task T6b. Everything above is tested against a scripted GitHub
provider and a fake workspace.

## Configuration

| Name                     | Kind            | Purpose                                                                                                                        |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_OAUTH_CLIENT_ID` | Worker variable | The GitHub OAuth app the device flow belongs to. Not a secret. Without it, starting an authorization answers `not-configured`. |
| `GH_TOKEN`               | Worker secret   | The documented credential source for automated tests and unsupervised runs.                                                    |

Set the secret with `wrangler secret put GH_TOKEN` and the variable in the Worker configuration or
with `wrangler secret put GITHUB_OAUTH_CLIENT_ID` if you prefer to keep it out of the repository.

## The `GH_TOKEN` fallback

Tasks that run without a person at a browser still need a credential. When the workspace has no
usable credential and `GH_TOKEN` is set, cf-stumble installs that token into the workspace exactly
as it installs one from the device flow, and records the connection with the source
`configured-token`. The connection status therefore says which credential is in use, and a token
from a secret never appears as an owner authorization.

This is a test and development path. It obeys the same rules as the device flow: the token reaches
the workspace and nothing else, and no response, log, or stored row carries it. It is not a second
production authorization mechanism, and a deployment that sets neither `GITHUB_OAUTH_CLIENT_ID` nor
`GH_TOKEN` reports `disconnected` instead of guessing.

## Where the credential lives

`WorkspaceHost.credential` is the only path that carries a token into the workspace. It runs
`gh auth login --with-token` with the token on the command's standard input, then runs
`gh auth setup-git`. The token is never part of a command line, never part of a result, and never
written to a file, so no interrupted install can leave one behind.

After that, `git` and `gh` authenticate the way they do on any development machine. cf-stumble does
not proxy GitHub operations, and the Supervisor keeps no copy of the token: the tenant's storage
holds a login name, the credential source, and the time it was recorded.

Because the Supervisor keeps no copy, a workspace that loses its filesystem loses the credential.
The status command reports that as `reconnect-required` rather than as a connection, so cf-stumble
never claims a working credential that ordinary tools cannot use. An unattended deployment with
`GH_TOKEN` set reinstalls the token by itself.

## Redaction

`src/github/redaction.ts` removes GitHub token prefixes and URL credentials from any text that
leaves the workspace, such as an error `git` printed. Redaction is the last line, not the design:
no type that crosses an HTTP, RPC, or storage boundary has a field for a token.
`test/github/credential-surfaces.test.ts` drives a whole authorization with a recognizable fake
token and then searches every one of those surfaces for it.

## What the pinned image must provide

ADR-0039 expects the Computer image to carry the development tools. E8 records Git on the pinned
pair. If `gh` is missing, the credential commands report `tooling-missing`, and cf-stumble neither
installs a package nor reports a connection. Confirming `gh` on the pinned image needs a paid
probe, which task T6b covers.
