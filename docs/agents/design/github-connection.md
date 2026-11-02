# Connecting GitHub repositories

How cf-stumble connects a GitHub repository to the owner's tenant, where the GitHub credential lives, and which credential source an automated run uses. ADR-0038 and ADR-0039 are the decisions behind it: one shared Computer workspace, and repository authorization through a credential in the workspace's local `gh` configuration.

## The connected project list

A project is an id, a display name, and a public repository URL (`src/project-catalog.ts`). The Supervisor keeps the list in its SQLite table `connected_projects`. A deployment starts with no projects.

The id comes from the canonical repository URL, never from a counter, so connecting the same repository twice converges on one project and connecting another changes no other project's id. The id is also the project's directory name under `/workspace/projects/`, a URL path segment, and the key of its thread, so two repositories must never share one. GitHub ignores case but not punctuation, so `projectIdForRepository` builds the id from the lower-case words of `owner/repository` plus, only when a separator is not the expected one, an exact punctuation key after `--`. `sakompella/emaily-demo` becomes `sakompella-emaily-demo`, and `owner/a.b` becomes `owner-a-b--2d`. An exact key was chosen over a hash suffix because a hash can collide, on purpose too. An id longer than `PROJECT_ID_LIMIT` is refused. An id has only lower-case letters, digits, and hyphens, so none can name the `<id>.provisioning` directory beside a clone. Only `github.com` URLs of exactly `owner/repository` derive an id. `ConnectedProjects.connect` refuses a URL that derives the harness entry's id with `project-id-conflict`.

## Connecting a repository

`Supervisor.connectProject` runs these steps in order (`src/supervisor/projects/project-connections.ts`):

1. Canonicalize the URL and derive the id.
2. Make the workspace credential usable, without a person if possible.
3. Check that the repository is readable with `git ls-remote` through the credential helper `gh auth setup-git` configured. A clone takes the same path.
4. Record the project in `connected_projects`.
5. Provision the project: reconcile its clone in the workspace and rewrite the managed instructions file.

Before it makes a new clone, the clone step measures the repository with `gh api` inside the workspace, so it reads a private repository the device flow authorized. The limits are 3,000 blobs, 150,000,000 total blob bytes, 5,000,000 KB repository size, and a complete tree. A repository over a limit makes the step exit with code 122 before `git clone` runs, and connection and provisioning report `repository-too-large` (`src/github/repository-size-guard.ts`, `projectCloneSource` in `src/project-provision.ts`). Exit code 122 also means a full disk, so the code alone does not say which check refused. This check fails open: a missing `gh`, a failed or timed-out request (5 s with `timeout`), or unexpected output lets the clone continue. It never measures or removes an existing clone.

If provisioning fails, cf-stumble removes a project it has just recorded. Provisioning also runs when a project is used, so a workspace the platform recreated is repaired on the next turn.

## Disconnecting a repository

`POST /api/projects/{id}/disconnect` needs an `Origin` that matches the request origin. It refuses an invalid or unknown id, the harness project, and a project with an active turn (`src/routes/projects.ts`).

On success the Supervisor removes the project thread and catalog row, then asks the Workspace Host to remove the clone and its `.provisioning` directory (`src/workspace/project-removal.ts`). This deletes uncommitted work in the clone. Workspace removal is best effort: `ok: true, workspace: "failed"` means the thread and row are gone although cleanup failed. A refusal leaves the project connected.

Two mechanisms keep a disconnect from overlapping other work on the same project. Inside one Supervisor, connection, disconnect, and provisioning on use run one at a time per project id (`src/supervisor/projects/project-lifecycle-queue.ts`), which is in memory and lost when the platform replaces the Supervisor. A kernel `flock` on `/tmp/cf-stumble-project-<id>.provision.lock` in the container covers that case (`holdProvisionLock` in `src/project-provision.ts`). Every process the command starts inherits the lock, so a clone that starts while a removal's `rm` is still running waits for it, even after the removal's shell was killed. A container restart releases it. Commands a turn runs do not take the lock, and a waiter is bounded only by the 900-second workspace command ceiling.

## Durable results of clone and removal

Computer runs a command in the container and then copies the container's changes into the Workspace Host's durable store. A replacement container starts from that store. The pinned Computer reports the copy as `sync.status`, `complete` or `pending`, with any skipped entries. A `pending` copy can follow a command that exited 0, and the Host configures no retry for it.

The Host therefore runs the clone step and project removal with `require-complete` (`src/workspace/computer-operations.ts`). A pending copy or skipped entries fail the step with `workspace-sync-incomplete`. The step is also checked against the store through `Workspace.fs.lstat` (`src/workspace/executor.ts`):

- After a clone exits 0, the project root and its `.git` must exist in the store, and the stored `.git/config` must name the catalog's repository as `origin`. Otherwise connection reports `provisioning-failed` and removes the new row. These are markers only and do not prove the stored repository is complete.
- After a removal exits 0, neither the clone nor its `.provisioning` directory may exist in the store. Otherwise disconnect reports `workspace: "failed"`. The old clone can then come back with a replacement container, and a later connection of the same repository reuses it with its uncommitted work.

The credential install also runs with `require-complete`; when its copy is pending, the Host logs the credential out and the install fails with `workspace-sync-incomplete` (`src/workspace/github-credential.ts`). Build, credential status and repository checks, and managed-instruction commands do not require a complete copy. Whether a clone left in the store returns after a Host or container replacement is unproven.

### Partial copies

Computer applies a copy in batches, so a copy that ends `pending` can leave part of its changes in the store: a clone with the root, `.git`, and `.git/config` but only some objects or files, or a removal that left some files. A replacement container restores that, the marker check passes, and the clone step reconciles it as an existing repository. Nothing in cf-stumble detects this, and cf-stumble never deletes a populated clone itself, because it may hold uncommitted work. If a project's Git commands fail in ways that suggest missing objects or files:

1. Run `git -C /workspace/projects/<id> fsck` and `git -C /workspace/projects/<id> status` in the workspace.
2. Ask the owner before you remove anything. The clone can hold uncommitted changes and unpushed commits that exist nowhere else.
3. Save what the owner wants to keep first: `git diff`, `git format-patch @{upstream}..`, or a plain copy of the files.
4. With the owner's approval, run `git fetch` in the clone, or remove it and let the next turn clone it again. A workspace reset removes every project's clone.

## The owner authorization

The Supervisor uses GitHub's OAuth device flow. It asks GitHub for a device code, the page shows only the verification URL and the short user code, and the owner signs in there. The Supervisor then redeems the authorization and installs the token into the workspace. The device code is deleted when it is redeemed, denied, or expires, so a replay finds nothing to redeem, and GitHub's answer for a code that a newer authorization replaced is discarded, token included.

## Reading the connection status

`GET /api/github/connection` answers from the Supervisor's storage and never reaches the Workspace Host. It returns `{ ok, github, checkedAt }`: what the last credential check found and when it ran. A pending authorization shows as `awaiting-authorization`. Both fields are `null` before the first check and after a workspace reset.

`POST /api/github/connection/refresh` runs a check in the workspace (`gh auth status` and `gh api user`), stores the result, and answers in the same shape. A connect, a credential install, and the provisioning before a turn store their results too. A check that a cancelled turn stopped is not stored. Neither is a check that a workspace reset overtook: each check captures the reset revision when it starts and stores its result only if the revision is unchanged. `GET /api/projects` lists the catalog and carries no connection status.

On load the page reads the recorded status with `GET /api/github/connection`, which does not reach the workspace. It sends the refresh only when the owner presses **Check again**, never on a timer. Each check runs container commands, and the Host counts every call as work, so a client that repeated a status read once kept the container running all day (`docs/agents/incident-2026-09-container-cost.md`).

## Configuration

| Name                     | Kind          | Purpose                                                                                                                         |
| ------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_OAUTH_CLIENT_ID` | Worker secret | The GitHub OAuth app the device flow belongs to. Not sensitive. Without it, starting an authorization answers `not-configured`. |
| `GH_TOKEN`               | Worker secret | The credential source for automated tests and unsupervised runs.                                                                |

Set both with `cf workers secrets update`. See `docs/deploy.md`, "Instance secrets".

## The `GH_TOKEN` fallback

When the workspace has no usable credential and `GH_TOKEN` is set, cf-stumble installs that token exactly as it installs one from the device flow and records the connection with the source `configured-token`, so the status says which credential is in use. A deployment that sets neither `GITHUB_OAUTH_CLIENT_ID` nor `GH_TOKEN` reports `disconnected`.

## Where the credential lives

`GitHubCredentialRequest` carries the token over the credential-install RPC to `WorkspaceHost.credential`. The Host passes it to `gh auth login --with-token` on standard input, then runs `gh auth setup-git`. The token is absent from command text and temporary files. `gh` writes it to `/workspace/.config/gh/hosts.yml` and the Git credential helper goes to `/workspace/.gitconfig`, both outside the repositories. Every credential command exports `GH_CONFIG_DIR` and `GIT_CONFIG_GLOBAL` with those locations, and the workspace image sets the same variables for all other commands (`src/workspace-layout.ts`, `src/github/credential-commands.ts`, `containers/computerd.Dockerfile`). `GIT_CONFIG_GLOBAL` takes precedence over `HOME`, so `git config --global` under a temporary `HOME` still writes `/workspace/.gitconfig`.

After that, `git` and `gh` authenticate as on any development machine. cf-stumble does not proxy GitHub operations, and the Supervisor stores only a login name, the credential source, and the time it was recorded.

Computer persists only `/workspace`, so the credential survives a container replacement, and the token also rests in the Host's Durable Object storage as the content of `hosts.yml`. The install waits for a complete sync of that copy, so a pending copy fails the install with `workspace-unavailable`, and the Host first runs a best-effort `gh auth logout` (the active account only) so the next status read does not report `connected`. The computerd shim does not keep file modes, so a restored `hosts.yml` can be mode 0644; the container has one user, root. The agent's file tools can read `/.config/gh/hosts.yml` directly.

Only a workspace reset clears the credential on purpose: it deletes the durable store and the Supervisor clears its record. If the workspace loses its `gh` configuration otherwise, status reports `reconnect-required` when the Supervisor had recorded a connection, and `disconnected` when it had not. A request that ensures credentials reinstalls a configured `GH_TOKEN` without owner action (`GitHubConnection.ensureCredential` in `src/supervisor/projects/github-connection.ts`).

## Redaction

`src/github/redaction.ts` removes recognized GitHub token prefixes and URL credentials from text on credential paths, and structured event fields pass through the same redaction in `logEvent` (`src/diagnostics.ts`). Neither proves every exception or plain-text log line hides every secret. `test/github/credential-surfaces.test.ts` checks the authorization surfaces with a recognizable fake token.

## What the pinned image must provide

ADR-0039 expects the Computer image to carry the development tools. If `gh` is missing, the credential commands report `tooling-missing`, and cf-stumble neither installs a package nor reports a connection.
