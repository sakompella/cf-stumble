# Owner project turns

Observed on the owner's deployment on 2026-09-24. The requests used the owner's own Cloudflare Access identity. The Worker had been deployed from the Mac.

## Generation 3

Generation 3 used harness commit `6aa267a8b48c478098ed91632ef7470010ea4aa5`. The first submission request remained open until the client timed out after 2,490 seconds. A repeat submission confirmed that the generation was ready and that its cold `GET /` check returned 200:

```json
{
  "ok": true,
  "outcome": {
    "kind": "candidate-submitted",
    "generation": {
      "label": 3,
      "harnessCommit": "6aa267a8b48c478098ed91632ef7470010ea4aa5",
      "status": "ready"
    },
    "epoch": 7
  },
  "preparation": {
    "ok": true,
    "report": {
      "stage": "ready",
      "reason": "response body completed in 29 bytes",
      "status": 200,
      "generation": {
        "label": 3,
        "harnessCommit": "6aa267a8b48c478098ed91632ef7470010ea4aa5",
        "status": "ready"
      },
      "effect": "no-op"
    }
  }
}
```

The first activation attempt used epoch 7 after the submission had advanced the epoch to 8. The supervisor refused it:

```json
{ "ok": false, "problem": { "code": "stale-epoch" } }
```

This was the stale-epoch guard working. An activation with the current epoch succeeded at epoch 9:

```json
{
  "ok": true,
  "outcome": {
    "kind": "activated",
    "generation": {
      "label": 3,
      "harnessCommit": "6aa267a8b48c478098ed91632ef7470010ea4aa5",
      "status": "ready"
    },
    "epoch": 9,
    "effect": "activated"
  }
}
```

## Criterion 4: a repository turn

The turn worked in `/workspace/projects/sakompella-emaily-demo`. It began with these reads:

```text
tool-start   read  {"path":"README.md"}
tool-result  read  "# Generative Inbox\n..."
tool-start   read  {"path":"package.json"}
tool-result  read  "... \"test\": \"vitest run\" ..."
```

It then made this edit:

```text
tool-start  edit  {"edits":[{"newText":"## Demo notes\n\nExercised by cf-stumble on 2026-09-23.\n","oldText":"## Demo notes\n"}],"path":"README.md"}
tool-result edit  "Successfully replaced 1 block(s) in README.md."
```

The configured command could not start because the image did not contain Bun:

```text
tool-start  bash  {"command":"bun run test 2>&1 | tail -30","timeout":240}
tool-result bash  "/bin/sh: 1: bun: not found"
```

After installing the dependencies with npm, the turn ran the same Vitest test command through `npx`:

```text
tool-start  bash  {"command":"npx vitest run 2>&1 | tail -20","timeout":240}
tool-result bash  "Test Files  3 passed (3)
      Tests  10 passed (10)
   Duration  9.67s"
```

The three passing files were `lib/inbox/operations.test.ts`, `lib/inbox/catalog.test.ts`, and `lib/inbox/instruction.test.ts`. The turn finished with `git diff README.md`. Its result contained the added line:

```diff
 ## Demo notes

+Exercised by cf-stumble on 2026-09-23.
+
 The API route requires the browser to connect a ChatGPT session ...
```

The server saved the completed thread as revision 1 with 16 messages. The client connection had dropped by then, but reading the thread returned the tool calls, results, final answer, and saved revision.

## Criterion 5: files outlive conversation history

An install-free turn added a second dated line to `README.md`, showed `README.md | 2 ++`, streamed the diff, and saved revision 4. The fresh-thread request then returned an empty conversation at revision 5:

```json
{
  "ok": true,
  "thread": {
    "projectId": "sakompella-emaily-demo",
    "conversation": "[]",
    "messageCount": 0,
    "revision": 5,
    "turnActive": false
  }
}
```

A turn in that new thread checked the repository without installing anything. Its command and result were:

```text
tool-start  bash  {"command":"git status --short && echo --- && git diff --stat"}
tool-result bash  " M README.md
---
 README.md | 2 ++
 1 file changed, 2 insertions(+)"
```

The turn also quoted the first sentence of the managed workspace instructions verbatim:

> "cf-stumble writes this file when it provisions the workspace and rewrites it on every restart."

It streamed the preserved `README.md` diff and saved revision 6. The empty conversation and preserved modified file show that starting a fresh thread clears conversation history without resetting the workspace files.

## Failures found during the check

- The model was never told its working directory, so an earlier turn worked in `/workspace/harness` instead of the selected project. Commit `088ec96` added the directory and turn budget to the model instructions.
- A turn deadline was reported as `malformed-frame`, and the 240-second limit was too short for the repository check. Commit `3decd6d` reports deadline cancellation as `timed-out`. Commit `27be515` raised and centralized the turn and lease limits.
- `npm install` inside the project left the durable workspace unable to answer later calls. Merge commit `f65c420` added the owner reset and moved dependency trees toward container-local storage. Commit `57e5a1f` made the route reset the tenant workspace rather than the namespace. Commit `4a8c8e7` rebuilt the in-memory Workspace after the reset erased its tables.
- The first dependency-tree probe after a reset returned `workspace-unavailable`. A later probe showed that the container honored `node_modules -> /tmp/cf-stumble-project-modules/sakompella-emaily-demo/node_modules`, then installed dependencies and passed all 10 tests. The workspace still became unresponsive after that turn. The symlink did not prevent the failure, and the investigation remains open.
