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

| step                               | time           |
| ---------------------------------- | -------------- |
| submit to ready, cold pnpm store   | 334 s to 439 s |
| submit to failed, broken candidate | 510 s          |
| activate                           | 0.3 s          |
| rollback                           | 0.26 s         |
| a turn with three tool calls       | 7.7 s          |
| a turn answering from the thread   | 2.5 s          |

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

## 7. The tracked configuration provisions from nothing

The one thing the deploy button does that this run cannot drive is Cloudflare's own fork and
provisioning screen, which needs a browser login. What that screen consumes is
`wrangler.jsonc`, and the handoff's worry was whether **this repository's** configuration survives
it. That part is testable, and it does.

A second Worker was deployed from the tracked configuration with three deviations only: a different
name, an absolute `main`, and the container image named by the registry digest instead of the
Dockerfile, which is what Workers Builds produces from that same Dockerfile. No Access variables at
all, so the state is a fresh account before the user has configured anything.

Cloudflare created, from nothing:

```
Worker            cf-stumble-buttonprobe, with its workers.dev route
Durable Objects   SUPERVISOR and WORKSPACE_HOST, new namespace ids, SQLite migrations applied
Container app     cf-stumble-buttonprobe-workspacehost (a0362fc9-...), instance_type basic
Bindings          ai AI, worker_loader LOADER, plain_text HARNESS_REPOSITORY_URL,
                  durable_object_namespace SUPERVISOR, durable_object_namespace WORKSPACE_HOST
```

And with nothing configured it failed closed, exactly as `docs/deploy.md` tells the reader it will:

```
GET /            no credential      401  Unauthorized
GET /api/status  no credential      401  Unauthorized
GET /            with a credential  500  Unauthorized   (invalid-configuration)
```

The probe Worker and its container application were then deleted, so the account is back to one
Worker and one container application. What remains unproved about the button is Cloudflare's fork
and provisioning screen itself, which needs an interactive login.

## 8. The real page, in a real browser, against the deployment

The 41 browser cases drive the real page against a stub owner API. This is the page against the
deployment itself: headless Chromium, the Access token set as the `CF_Authorization` cookie the way
a signed-in browser sends it, and nothing else faked.

```
document.title                     "cf-stumble"
#owner-page                        present
#project-list > li                 ["harness/workspace/harness"]
#project-list-status               "no repository connected yet"
click the harness entry            #conversation-project becomes "harness"
active-generation-label            3
active-generation-commit           a199797e1dd61828ced853c8c0c1b9876ce396f7
active-generation-status            ready
generation-epoch                   13
console errors                     0
```

That is demo step 1 and demo step 2 against the deployment. The drawer shows the generation this
run built, activated and rolled back to, read from the deployed Supervisor rather than a fixture.

Then a turn, driven by the page's own prompt box and Send button rather than by `curl`:

```
#turn-state            "running"
thread afterwards      revision 16, 50 messages, turnActive false
transcript             "you Reply with exactly: page probe ok."
                       "assistant page probe ok."
                       "you Reply with exactly: page probe two ok."
                       "assistant page probe two ok."
```

Two page-driven turns completed and were saved. The transcript on the next load also carries the
whole earlier coding turn, its tool calls and its diff, so the conversation survives a reload.

Four page-driven turns completed and saved across these runs. Every one of them was sent by the
page, streamed by the deployment and written to the thread.

One measured behavior, and a correction I nearly filed as a page defect. Each probe run saw
`running` at capture time while the reply landed later, and the same turn through `curl` takes
1.9 s. That is not page latency. A probe that closes the browser mid-stream abandons its turn, the
turn lease then holds the project until its deadline, and the page guards its own Send button on
the thread's `turnActive`. So a probe that fires Send three seconds after selecting a project races
the previous probe's lease. `wrangler tail` settled it: in the run where the page appeared stuck,
there was **no `POST /api/projects/.../turn` at all**, only the page's own `GET` of the status,
projects and thread. The page had correctly refused to start a second turn. The lease and the guard
were both doing their job, and the probe was the thing at fault.

Screenshots for the narration are in `/tmp/page-probe/` on hp (`01-owner-page.png`,
`02-after-turn.png`). They are not committed, because `.audit/` is gitignored and the repository
holds no binaries.
