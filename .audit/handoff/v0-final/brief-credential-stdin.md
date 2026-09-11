# Brief: install the GitHub credential without a staging file

You are a code worker for cf-stumble. The orchestrator merges and deploys; you do not.

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/credential-stdin -b work/credential-stdin origin/main
cd /home/aditya/wt/credential-stdin
```

Work only there. Read `.audit/` from `/home/aditya/repos/cf-stumble/.audit/`.

## The fault, measured on the deployed owner instance

No GitHub credential can be installed, so no repository can be connected, so the product's whole
project half is unreachable on a real deployment. The owner sees
`{"state":"reconnect-required","reason":"workspace-unavailable"}` and nothing else, because the
credential path deliberately never logs.

The cause, read from a temporary probe that has already been removed:

```
WorkspaceFsError: parent directory missing: /tmp/cf-stumble-gh-token
```

`installCredential` in `src/workspace/github-credential.ts` writes the token to
`GITHUB_TOKEN_STAGING_PATH`, which is `/tmp/cf-stumble-gh-token`
(`src/github/credential-commands.ts`). That write goes through `operations.writeFile`, which is
Computer's **workspace filesystem**, not the container's. The workspace has no `/tmp`, so the write
throws, the catch-all returns `workspace-unavailable`, and the cause is discarded.

This blocks both credential routes, which is why it matters more than it looks: the documented
`GH_TOKEN` fallback ends in this same install, and so does the owner's interactive device
authorization. Neither can ever succeed today.

## What to build

Stop staging the token in a file. `gh auth login --with-token` reads the token from standard
input, which is what it is for, and Computer's `exec` accepts `stdin`
(`node_modules/@cloudflare/computer/dist/index.d.ts`, `stdin?: Uint8Array | string`).

- Add an optional stdin to the workspace operations port, `runCommand(source, cwd, timeoutMs,
  stdin?)` in `src/workspace/executor.ts`, and pass it through
  `src/workspace/project/../computer-operations.ts` to `workspace.runtime.exec`.
- Change `installCredentialSource` so the command reads the token from stdin rather than a path,
  and have `installCredential` pass the token as stdin.
- Delete what the staging file needed: the staged write, `clearStagedToken`, and
  `GITHUB_TOKEN_STAGING_PATH` if nothing else uses it. A token that never touches a filesystem
  cannot be left behind on one, which is a stronger version of the property the staging dance was
  written to protect. Say that in the commit message, and update the module comments that explain
  the old approach so they describe the new one.
- The `run-command` plan in `src/workspace/decisions.ts` carries the fields the executor needs. If
  you add stdin there, remember a plan is a plain structured-cloneable value and a token must
  **not** become part of a logged or returned plan. Prefer keeping stdin out of the plan and
  passing it at the call, and say which you chose and why.

## What must stay true

- `test/github/credential-surfaces.test.ts` holds the invariants that matter here: no module on the
  credential path writes to a log, and no credential reaches a repository, a stored module map, a
  response or saved state. Keep every one of them passing, and do not add logging to that path.
- A failed install must still report `credential-command-failed` with redacted text, and an
  unavailable workspace must still report `workspace-unavailable`.
- `gh auth setup-git` must still run, so Git uses the credential afterwards.

## Tests

Add one that would have caught this: the install must not depend on any filesystem path, stated as
a property rather than by asserting a string. The existing fake in
`test/github/credential-surfaces.test.ts` and `test/workspace/*` will show you the shape. Update
every test that asserts the staging path or the old command text.

## The gate

`pnpm verify` green before every commit; the hook runs it. `pnpm format` fixes formatting. Rebase
on `origin/main` before you push and verify again. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/credential-stdin`.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 400 words: the
branch and SHA, how the token now reaches `gh`, what you deleted, where you put stdin and why, the
test you added, the `pnpm verify` line, and anything in this brief that was wrong.
