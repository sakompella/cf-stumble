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

The id is also the project's directory name under `/workspace/projects/`, a URL path segment, and
the key of its thread, so two different repositories must never share one. GitHub compares owner
and repository names without regard to case, but punctuation is part of the name: `owner/a-b`,
`owner/a.b`, and `owner/a_b` are three repositories. `projectIdForRepository` in
`src/project-catalog.ts` builds the id from the lower-case `owner/repository` in two parts:

- The words: every run of letters and digits, joined by single hyphens. `owner/a.b` gives
  `owner-a-b`.
- A punctuation key after `--`, present only when a separator is not the expected one. The
  expected separator is `/` after the first word, `-` after every later word, and nothing after the
  last word. Each key entry is the separator's position, counted from 1 for the separator after
  the first word, followed by one letter per character: `s` for `/`, `h` for `-`, `d` for `.`, and
  `u` for `_`.

| Repository                        | Project id                              |
| --------------------------------- | --------------------------------------- |
| `sakompella/emaily-demo`          | `sakompella-emaily-demo`                |
| `owner/a.b`                       | `owner-a-b--2d`                         |
| `owner/a_b`                       | `owner-a-b--2u`                         |
| `owner/.github`                   | `owner-github--1sd`                     |
| `owner-a/b`                       | `owner-a-b--1h2s`                       |
| `sakompella/sakompella.github.io` | `sakompella-sakompella-github-io--2d3d` |

The words and the key together restore every character of the lower-case name, so the rule is
injective. An id without a key is exactly the id the earlier rule gave, which kept every project
whose owner has no hyphen and whose name has no `.` or `_`, including the owner's
`sakompella-emaily-demo`, in its directory and thread. A repository whose owner has a hyphen gets a
key, because otherwise `a-b/c` and `a/b-c` would share `a-b-c`.

An exact key was chosen over a short hash suffix. A hash is shorter for heavily punctuated names,
but distinct repositories could share one, and a colliding name could be made on purpose. The key
adds four to six characters for the names people use and keeps the directory name readable. Its
cost is a length limit: an id longer than `PROJECT_ID_LIMIT` (200 characters) is refused, which
only a name with dozens of dots or underscores reaches. An id uses only lower-case letters, digits,
and hyphens, so no id can name the `<id>.provisioning` directory that provisioning keeps beside a
clone, or the `<id>.provision-lock` directory that earlier versions kept there. Only `github.com`
URLs of exactly `owner/repository` derive an
id, because these naming rules are GitHub's.

If a repository's id is already stored for a different repository, or the repository is already
stored under a different id, cf-stumble refuses the connection with `project-id-conflict`. With
injective ids, only a row that the earlier rule stored can cause this. cf-stumble does not repoint
an existing project at a different clone, because the project's thread and files belong to the
repository it was stored for. The same repository written in another case converges on the
existing project.

## Connecting a repository

`Supervisor.connectProject` performs these steps in order (`src/supervisor/projects/project-connections.ts:239-304,432-470`):

1. Canonicalize the GitHub URL and derive the project id. Query GitHub for repository size and the default branch's recursive tree. Refuse a known oversized repository or truncated tree before asking the workspace for a credential. If the lookup fails or returns malformed data, skip the size preflight and continue.
2. Make the workspace credential usable, if possible without a person. Leave a working credential alone.
3. Ask the workspace whether the repository is readable, by running `git ls-remote` through the credential helper that `gh auth setup-git` configured. This is the same access path a clone takes.
4. Record the project in `connected_projects`.
5. Provision the project: reconcile its clone inside the tenant's one workspace and rewrite the managed instructions file. A new clone is measured first, as described below.

The preflight refuses more than 3,000 blobs, more than 150,000,000 total blob bytes, a GitHub repository size above 5,000,000 KB, or a truncated default-branch tree. It returns `repository-too-large` for each refusal (`src/github/repository-size.ts:9-60`; `src/supervisor/projects/project-connections.ts:64-87`). Its API requests use `GH_TOKEN` when configured, not the device-flow credential held inside the workspace (`src/github/repository-size.ts:115-170`). For a private repository authorized only by device flow, the preflight lookup can fail, and the connection then continues without a preflight result.

The clone step measures the repository again before it makes a new clone. It runs `gh api` inside the workspace, so it uses the workspace's own `gh` credential and can read a private repository that the owner authorized through the device flow. It makes the same two REST requests and applies the same limits in the same order. GitHub reports the repository `size` in kilobytes and each tree entry's `size` in bytes. A repository over a limit makes the clone step exit with code 122 before `git clone` runs, and both connection and provisioning on use report `repository-too-large` (`src/github/repository-size-guard.ts`; `src/project-provision.ts:157-212`). Exit code 122 also means that the clone ran out of disk, so the result alone does not say which check refused. The check runs only when no clone exists, so it also covers a clone recreated after a workspace reset from a repository that has grown since it was connected. It measures the default branch at that time and never measures or removes an existing clone.

The clone-time check fails open, like the preflight. When `gh` is missing, a request fails or times out, or `gh` prints anything other than the expected fields, the check reports the repository as unmeasured and the clone continues. The clone step refuses only on one of the four named ceilings, so an unexpected verdict also lets the clone continue. The check discards `gh`'s error output and prints only a verdict word, so no credential text reaches the step's output. A public repository recloned while the workspace has no `gh` credential may also be unmeasured; whether `gh api` answers without a credential was not checked. The check limits each request to 5 seconds with `timeout` when the image provides it. The image's runtime stage is `debian:stable-slim`, where `timeout` comes from the essential `coreutils` package. On 2026-09-27 that image (Debian 13.7) had `/usr/bin/timeout` from coreutils 9.7. The tag is not pinned, so a later image is unchecked. Without `timeout`, a `gh` request is limited only by the 900-second workspace command ceiling, and a request that hangs fails the clone instead of letting it continue. The tests run the planned shell with stub `gh` and `git` commands; no test has run this check against GitHub or inside Computer.

If provisioning fails, cf-stumble removes a project it has just recorded. Provisioning also runs when a project is used, so a workspace that the platform recreated is repaired on the next turn.

## Disconnecting a repository

The owner can call `POST /api/projects/{id}/disconnect` with an `Origin` exactly matching the request origin. The route refuses an invalid or unknown project id, the harness project, and a project with an active turn. An expired lease can be reclaimed (`src/routes/projects.ts:99-115,245-267`; `src/supervisor/supervisor.ts:252-262`).

On success, the Supervisor removes the project thread and catalog row, then asks the Workspace Host to remove the clone, its `.provisioning` directory, and the `.provision-lock` directory that earlier versions locked with (`src/supervisor/supervisor.ts:253-261`; `src/supervisor/projects/project-connections.ts:311-343`; `src/workspace/project-removal.ts:52-75`). The removal command first takes the project's provision lock, the same lock the clone step takes. When workspace cleanup succeeds, disconnect deletes uncommitted work in that clone. Workspace removal is best effort: `ok: true, workspace: "failed"` means the thread and catalog row are gone even though workspace cleanup failed. A refusal leaves the project connected.

Two mechanisms keep a disconnect from overlapping other work on the same project. Inside one Supervisor, connection (from recording the row through provisioning), disconnect, and provisioning on use run one at a time for each project id (`src/supervisor/projects/project-lifecycle-queue.ts`). The Supervisor removes the thread inside that same operation, so no turn can start between the thread removal and the row removal. The queue exists only in memory. It moves on when the removal RPC returns, fails, or times out, and it is lost when the platform replaces the Supervisor instance, while the removal command may still be running in the workspace. The provision lock covers that case.

The provision lock is a kernel `flock` on `/tmp/cf-stumble-project-<id>.provision.lock` in the container, held through descriptor 9 (`src/project-provision.ts:99-121`). It follows the pattern of the harness provision lock in the audit finding 5 change. The file is outside `/workspace`, so Computer's storage copy cannot replace it, and nothing deletes it. The id alphabet is letters, digits, and `-`, so the name is a safe file name, and one project's lock does not order another project's work. Nothing records a process id, so nothing can mistake a live holder for a stale one. Every process the command starts inherits the descriptor, and the kernel releases the lock only when the last of them exits. A clone that starts while a removal's `rm` is still running therefore waits for it, even after the removal's shell was killed, and a removal waits for a running clone. A container restart ends every holder and releases the lock.

Some limits remain. Commands a turn runs do not take the lock. `flock` blocks without its own timeout, so a waiter is bounded only by the 900-second workspace command ceiling. The Node tests run the real removal and clone scripts under `/bin/sh` with stand-ins for `git`, `rm`, and `flock` (Perl's `flock` on macOS). A manual run on 2026-09-27 in `debian:stable-slim` with `dash` and util-linux `flock` 2.41.5 showed a clone waiting for a removal whose shell had been killed, and the new clone surviving. Neither run used computerd or Computer, so how the container runs overlapping commands in production is unverified.

## Durable results of clone and removal

Computer runs a command in the container and then copies the container's changes into the Workspace Host's durable store. A replacement container starts from that store. The pinned Computer reports the copy as `sync.status`, either `complete` or `pending`, together with any entries it skipped. A `pending` copy can follow a command that exited 0, and the Workspace Host configures no retry for it. The flock only covers the shell, so it does not cover this copy.

The Workspace Host therefore runs the clone step and project removal with `require-complete` (`src/workspace/computer-operations.ts`, `src/workspace/host.ts`). A copy that is pending or skipped entries makes the step fail with `workspace-sync-incomplete`. The step is also checked against the durable store itself, through `Workspace.fs.lstat`, which reads the store rather than the container (`src/workspace/executor.ts`):

- After a clone exits 0, the project root and its `.git` directory must exist in the store, and the stored `.git/config` must name the catalog's repository as `origin`. Otherwise connection reports `provisioning-failed` and removes the new row, and a turn is refused before it starts. These are markers only. Passing them does not prove that the stored repository is complete.
- After a removal exits 0, neither the clone nor its `.provisioning` directory may exist in the store. Otherwise disconnect reports `workspace: "failed"`, never `removed`. The thread and catalog row are still gone, as for any failed cleanup, so the old clone can come back with a replacement container. A later connection of the same repository then finds that clone and reuses it, including any uncommitted work it held.

Build, credential, and managed-instruction commands do not require a complete copy. The checks read the store once, right after the command, and nothing retries a pending copy. The cross-eviction case is unproven: no test or deployment has shown whether a clone left in the store returns after the Workspace Host or its container is replaced, or whether a later copy from a replacement container keeps a removal. The operational events for these cases are in `observability.md`. The tests use shapes like the pinned Computer's results and a fake store. No test has run Computer, so how often a copy is pending in production is unknown.

### Partial copies

Computer applies a copy to the store in batches. A copy that ends `pending` can therefore leave part of its changes in the store. After a clone, the store can hold the root, `.git`, and `.git/config` but only some Git objects or working-tree files. After a removal, the store can still hold some of the deleted files. A replacement container starts from the store, so it can restore a partly broken clone. The marker check above passes for such a clone, and the clone step then reconciles it as an existing repository and does not clone again. Nothing in cf-stumble detects this case, and no test or deployment has observed it.

cf-stumble never deletes a populated clone by itself, because the clone may hold the owner's uncommitted work. If a project's Git commands fail in ways that suggest missing objects or files, recover by hand:

1. Check the clone first. Run `git -C /workspace/projects/<id> fsck` and `git -C /workspace/projects/<id> status` in the workspace.
2. Ask the owner before you remove anything. The clone can hold uncommitted changes and unpushed commits that exist nowhere else.
3. Save anything the owner wants to keep before any repair, for example `git diff` for uncommitted changes, `git format-patch @{upstream}..` for unpushed commits, or a plain copy of the files when Git commands fail.
4. Only with the owner's approval, repair or replace the clone. Either run `git fetch` in it, which may restore missing objects, or remove the clone and let the next turn clone it again. The owner can also reset the whole workspace, which removes every project's clone.

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
- Every state-changing route under `/api/` requires an `Origin` header that exactly matches
  cf-stumble's own request origin; a missing, `null`, or other value is refused.

The owner completed the live authorization on the deployment on 2026-09-11. [GitHub connection
evidence](../../release/v0/evidence/github-connection.md) records the result. Everything above is
also tested against a scripted GitHub provider and a fake workspace.

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

This is a test and development path. The configured token authenticates GitHub API requests for
the repository-size preflight and, when needed, crosses the credential-install RPC into the
Workspace Host. The device-flow token is used only for credential installation; it does not
authenticate the Supervisor's size preflight. The clone-time size check runs `gh api` inside the
workspace, so it uses whichever credential the workspace's `gh` holds. Public HTTP responses, structured operational event fields, and
Supervisor SQLite do not store either token. A deployment that sets neither
`GITHUB_OAUTH_CLIENT_ID` nor `GH_TOKEN` reports `disconnected` instead of guessing.

## Where the credential lives

`GitHubCredentialRequest` carries the token over the credential-install RPC to `WorkspaceHost.credential`. The Workspace Host passes it to `gh auth login --with-token` on standard input, then runs `gh auth setup-git`. The token is absent from command text and application-controlled temporary files; `gh` writes it to `/workspace/.config/gh/hosts.yml`, outside the repositories, and `gh auth setup-git` writes the Git credential helper to `/workspace/.gitconfig`. Every credential command exports `GH_CONFIG_DIR` and `GIT_CONFIG_GLOBAL` with those locations, and the workspace image sets the same variables for all other commands (`GITHUB_CLI_CONFIG_DIRECTORY` and `GIT_GLOBAL_CONFIG_PATH` in `src/workspace-layout.ts`; `src/github/credential-commands.ts`; `containers/computerd.Dockerfile`).

After that, `git` and `gh` authenticate the way they do on any development machine. cf-stumble does
not proxy GitHub operations, and the Supervisor keeps no copy of the token: the tenant's storage
holds a login name, the credential source, and the time it was recorded.

Computer persists only `/workspace`, so the credential files survive a container replacement: an image rollout, a crash, a platform stop, or a recovery relaunch. Earlier versions wrote them under `$HOME` (`/root`) on the container's own disk, and every replacement lost the credential. The token now also rests in the Workspace Host's Durable Object storage, as the content of `hosts.yml`, next to the repositories. The install waits for a complete sync of that copy (`"require-complete"`), so a copy that is still pending fails the install with `workspace-unavailable` instead of reporting `connected`. By then `gh` has written `hosts.yml` in the container, so the Workspace Host runs a best-effort `gh auth logout` before it returns the failure. Without that, the next status read would report `connected` and the Supervisor could record a configured-token install as a device authorization. The Supervisor still stores no token.

A workspace reset is the only event that clears the credential on purpose. It deletes the durable store, and the Supervisor clears its record. The computerd shim does not keep file modes when it restores files, so a restored `hosts.yml` can have mode 0644 instead of 0600. The container has one user, root, so this adds little risk. The agent's file listing of `/workspace` now shows `.config` and `.gitconfig`, and its file read tool can read `/.config/gh/hosts.yml` directly, not only through the shell.

`GIT_CONFIG_GLOBAL` takes precedence over `HOME`. A project test that sets a temporary `HOME` and runs `git config --global` therefore writes `/workspace/.gitconfig`, not a file under that `HOME`. `gh` still finds the token through `GH_CONFIG_DIR`.

The deployment that ships this change replaces the container, and the old credential sat on its disk. The owner authorizes GitHub once more after that deployment, unless `GH_TOKEN` is configured and reinstalls it.

Because the Supervisor keeps no copy, a workspace that loses its `gh` configuration loses the credential. If the Supervisor previously recorded a connection, status reports `reconnect-required`; without a prior record, a missing credential reports `disconnected`. A request that ensures credentials reinstalls a configured `GH_TOKEN` without owner action (`src/supervisor/projects/github-connection.ts:146-165,322-356`).

## Redaction

`src/github/redaction.ts` removes recognized GitHub token prefixes and URL credentials from text on credential paths, such as an error `git` printed. Structured operational event fields also pass through the redaction in `src/diagnostics.ts:101-128`. Neither mechanism proves that every exception or plain-text log line hides every possible secret. The install RPC carries a token by design, while public HTTP responses and Supervisor SQLite do not store it. `test/github/credential-surfaces.test.ts` checks intended authorization surfaces with a recognizable fake token.

## What the pinned image must provide

ADR-0039 expects the Computer image to carry the development tools. Git is present on the pinned
Computer source and image pair. If `gh` is missing, the credential commands report
`tooling-missing`, and cf-stumble neither installs a package nor reports a connection. The
2026-09-11 deployment observation confirmed that `git` worked in both workspace repositories. See
[GitHub connection evidence](../../release/v0/evidence/github-connection.md).
