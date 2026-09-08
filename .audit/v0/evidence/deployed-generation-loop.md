# The deployed generation loop, end to end

Recorded 2026-09-08 against the paid account, Worker `cf-stumble` at
`https://cf-stumble.adityakompella.workers.dev`, on the fresh Supervisor whose storage started
empty. Access verification runs against an injected JWKS (decision log D77). Every result below is
a real response from that deployment, in the order it happened.

## 1. A commit becomes a generation

`POST /api/generations/submit` with harness commit `a199797`:

```
{"ok":true,"outcome":{"kind":"candidate-submitted",
  "generation":{"label":3,"harnessCommit":"a199797...","status":"candidate"},"epoch":4},
 "preparation":{"ok":true,"report":{"stage":"ready","reason":"response body completed in 29 bytes",
  "status":200,"generation":{"label":3,"harnessCommit":"a199797...","status":"ready"},
  "effect":"recorded"}}}
```

334 s. Inside that: the harness repository cloned and the commit fetched, `git archive` extracted,
`pnpm run build:artifact` installed 186 packages and bundled a 942311 byte module map, the map was
stored in Supervisor SQLite, a candidate facet cold-started under the commit id through the Worker
Loader, and `GET /` on it answered 200.

## 2. Activation, and a stale epoch refused

An activation that named the epoch it had last seen was refused:

```
{"ok":false,"problem":{"code":"stale-epoch"}}
```

With the current epoch it succeeded, and `GET /` then served the generation's own facet:

```
{"ok":true,"outcome":{"kind":"activated","generation":{"label":3,...,"status":"ready"},
  "epoch":6,"effect":"activated"}}
GET /  ->  200  "generation-0 main facet ready"
```

## 3. A real coding turn

`POST /api/projects/harness/turn`, working directory `/workspace/harness`, prompt: add a line to
`README.md`, then run `git diff --stat`. The response stream, frame by frame:

```
tool-start   read
tool-result  read
tool-start   write
tool-result  write
tool-start   bash
tool-result  bash
text         "Done. The write tool reported a backend error, so I appended the line via a shell
              command instead. `git diff --stat` shows README.md with 2 insertions ..."
diff         diff --git a/README.md b/README.md
             @@ -1 +1,3 @@
              # cf-stumble
             +
             +Deployed proof: this line was added by the agent.
saved        revision 9
```

7.7 s. The agent read a file, wrote to it, ran a command, streamed its own account of what it did,
and the harness produced the diff. The thread was saved.

**A real defect this turn found, since fixed.** The workspace `write` tool answered
`backend-unavailable` and the agent worked around it with `bash`. The code is the fallback for an
error with no errno, so the cause was thrown away. Logging the unmapped error named it: the runtime
requires `state.storage.transactionSync()` rather than the SQL `BEGIN TRANSACTION` or `SAVEPOINT`
that Computer's own `workspace.db.transactionSync` issues. Fixed in `a50b14a`, and the same turn
then ran with the product's own tool:

```
tool-start   read
tool-result  read           "# cf-stumble"
tool-start   write
tool-result  write          "Successfully wrote 139 bytes to README.md"
tool-start   bash
tool-result  bash           " README.md | 3 +++\n 1 file changed, 3 insertions(+)"
text         "Done. I read README.md, rewrote it with the original line plus both proof lines,
              and `git diff --stat -- README.md` printed ..."
diff         diff --git a/README.md b/README.md
saved
```

9.8 s. Read, write through the product's own tool, a command with its output, the harness's diff,
and a saved thread.

A later turn in the same thread answered from the conversation alone:

```
text  "The line added to README.md was: `Deployed proof: this line was added by the agent.`"
```

## 4. A deliberately broken candidate leaves the active generation serving

Branch `probe/broken-candidate`, commit `cf8190e`, whose facet answers `GET /` with 500. Submitted
through the same path as any other candidate:

```
{"ok":true,"outcome":{"kind":"candidate-submitted",
  "generation":{"label":5,"harnessCommit":"cf8190e...","status":"candidate"},"epoch":11},
 "preparation":{"ok":true,"report":{"stage":"response-rejected","reason":"response status was 500",
  "status":500,"generation":{"label":5,...,"status":"failed"},"effect":"recorded"}}}
```

510 s. Immediately afterwards:

```
GET /api/status  ->  active generation 3, a199797, epoch 12
GET /            ->  200  "generation-0 main facet ready"
```

The candidate is `failed`, the active generation never moved, and the deployment kept serving. This
is the first clip the demo narration needs.

## 5. Rollback loads the stored module map with no build

`POST /api/generations/rollback` to label 3:

```
{"ok":true,"outcome":{"kind":"rolled-back","generation":{"label":3,...,"status":"ready"},
  "epoch":10,"effect":"activated"}}
```

**0.26 s.** `wrangler tail` for that window shows exactly two Supervisor calls,
`controlGeneration` and `getProjectThread`, and **no Workspace Host call at all**, so no build and
no container work happened. `GET /` kept answering, and the project thread was still there with its
own history. This is the second clip the narration needs.

## What this cost in wall time

| step | time |
|---|---|
| submit to ready, cold pnpm store | 334 s to 439 s |
| submit to failed, broken candidate | 510 s |
| activate | 0.3 s |
| rollback | 0.26 s |
| a turn with three tool calls | 7.7 s |
| a turn answering from the thread | 2.5 s |

## The five bugs this evidence found

Each was invisible to `pnpm verify`, to the local container preflight and to the browser harness,
and each is fixed on `main`:

1. `tar` metadata syscalls against Computer's userspace filesystem (`787ae6f`).
2. No time budget on a planned command, so Computer killed `pnpm install` (`787ae6f`).
3. A module map read through the workspace filesystem API, which cannot see what a container
   process wrote (`79b9e69`).
4. One Workspace Host stub held for a whole multi-minute build (`33d042e`).
5. An unbounded `pnpm install` log, which Computer holds in memory and which made the container
   exit 1 part way through every build (`a199797`).

And three more in the turn path:

6. A zero context window and output budget in the facet's model descriptor (`a15718d`).
7. Workers AI's default output budget, which truncated the model's answer to nothing (`194a76f`).
8. The provider stream parser read only Workers AI's classic `{response}` shape, while the model
   streams chat-completion chunks whose text and tool calls live in `choices[0].delta`
   (`2849183`). This one silently threw away every answer and every tool call.

And one in the workspace:

9. Every project-file write failed, because the write ran inside Computer's own SQL transaction
   rather than the Durable Object's (`a50b14a`).

## 6. Fail closed before configuration, and the fork variable

Two more deployed checks, each done by redeploying the same Worker with different variables.

**Partial Access configuration.** With `CF_ACCESS_TEAM_DOMAIN` set and `CF_ACCESS_AUD` and
`CF_ACCESS_OWNER_SUB` absent, every route refuses:

```
GET /?p=partial          with a credential      500  Unauthorized
GET /api/status          with a credential      500  Unauthorized
GET /api/projects        with a credential      500  Unauthorized
GET /  Accept: text/html with a credential      500
GET /                    with no credential     401
```

500 is the `invalid-configuration` refusal, which says the fault is the deployment's own. That is
what the fresh-account bootstrap requires, because the deploy button runs before the user
configures Access.

**`HARNESS_REPOSITORY_URL`.** With the variable set to a repository that does not exist, a
submission fails at its first step:

```
{"preparation":{"ok":false,"problem":{"code":"build-step-failed","step":"provision","exitCode":1}}}
```

16.5 s, and the active generation did not move. So the variable a fork has to change is honored by
the deployed build plan, and a wrong value fails at the clone rather than quietly building this
repository instead.
