# Product overview

cf-stumble is a personal agent that primarily helps with coding and can improve its own main harness. It is inspired by Autolith, Amp's Orbs, NixOS, and Cloudflare's Think. Its main harness runs its agent loop on Pi Durable, on Cloudflare Durable Objects, Dynamic Workers, Dynamic Worker facets, and Computer.

The product is meant first for one person. It should grow around that person's projects, instructions, working habits, and accumulated context. Coding is its primary use, not a permanent limit on what the harness may help with.

## The two harnesses

The **main harness** handles the user's work. Its model loop, prompts, tools, policies, and use of files may all change. One generation of the main harness runs in a Dynamic Worker facet, and Pi Durable runs its agent loop there (ADR-0048). No generation is a special rollback target.

The **supervisor** is the immutable half. It lives in the Supervisor Durable Object, which is the primary Durable Object for a cf-stumble instance and is not a facet. It creates main-harness facets, decides which generation may run, and refuses a candidate whose startup check fails so the generation that is serving keeps serving.

There is no recovery harness and no automatic repair. Recovery is the owner rolling back to a generation that already ran, which loads a stored module map and rebuilds nothing.

The supervisor reaches a facet through RPC: `compatibility` for the startup check, and `attach`, `createConversation`, `submit`, `events`, `entries` and `abort` for conversations (`src/facet/conversation-protocol.ts`). The serving facet reaches back through two hosts that `attach` hands it: the conversation host, and the generation control that reads status and submits, prepares, activates or rolls back a generation (`src/supervisor/conversations/host-target.ts`, `src/generation-requests.ts`). Nothing reaches a facet over HTTP: the Worker serves the page and the owner API and answers 404 for any other path. ADR-0003 does not fix this as a permanent contract.

## What the main harness knows and tries to do

For a piece of work, the main harness receives the user's request, applicable instructions, relevant session history, accumulated context, and access to the files and commands the work needs. It does not need unrestricted access to every project or to the supervisor's protected state. Its aim is to help the user finish useful work. It may edit code, run commands, or improve its own harness when that serves the goal, but self-modification is a capability, not the purpose of every session.

The supervisor has a narrower aim: keep a usable main harness available. It needs the generation record and the startup check's result, not the user's project context.

## Projects and files

A project is a GitHub repository that the user connects to cf-stumble. Each project has one current Pi Durable conversation, its thread. One Computer workspace holds the harness repository and every connected project repository in separate directories. The page lists projects in a collapsible left sidebar.

Starting a fresh thread points the project at a new conversation, so the old conversation and its compacted context stop being used, but the project files stay. Changing the generation keeps both. The Git histories stay separate, but the directories share one workspace and are not security boundaries.

The workspace behaves like a normal development machine, with unrestricted internet access and tools such as `git` and `gh`. GitHub credentials stay in local tool configuration outside the repositories. The supervisor does not interpret project files or conversation records; it only maps each project to its current conversation.

## Generations and self-improvement

A project commit is an ordinary commit. A harness commit becomes a generation only when the Supervisor gives that commit a generation label.

The owner submits a harness commit as a **generation candidate** with `POST /api/generations/submit` (`src/routes/generations.ts`). The Supervisor labels the commit, prepares it, runs the startup check, and records the result against that generation. The owner may then ask the Supervisor to activate a generation or roll back to an earlier one. The Supervisor validates each request and performs or rejects it. Mutable code cannot write protected generation state or bypass those checks. The main harness makes the same requests from a conversation with the `stumble` command (`src/stumble-cli/`): `stumble gen status`, `stumble gen prepare <sha>`, and `stumble gen activate|rollback <label> --epoch <n>`. The command runs in the facet, not in the container, and calls the generation control, which shares its validation and decisions with the HTTP routes. A generation activating itself ends its own facet; the next generation resumes the conversation from the Supervisor's alarm. Every activation is on probation until a real turn on it completes: if a turn fails because of the generation (its phase faulted, its session died, it kept restarting, or the turn hit the deadline) before one completes, the Supervisor rolls back to the last generation that completed a real turn (`src/supervisor/generation-machine.ts`). An owner cancel, a model or provider error, or a run left by a replaced facet neither proves nor fails the generation. The owner cannot activate or roll back while a run is active (`run-active`), the same as a reset; a generation activating itself from its own run can. The startup check runs a scripted model, so it cannot catch a fault that only a real model's turns reach.

The startup check mounts the candidate in a facet of its own, with a scripted model (`src/startup-check-model.ts`) and a generation control that only reads status. The candidate must report the Supervisor's facet compatibility within 5 seconds; the scripted conversation must then settle within 90 seconds. The serving generation's code (the candidate's own when none serves) opens the conversation and answers a first turn that runs one command in a scratch directory. The candidate then resumes it in the same facet storage and answers a second turn in steps: `parallel-tools` (one message with three bash calls: one in the isolate, `node --version` in the container, and the scratch command), `stumble-status` (`stumble gen status` must print the generation status), `write`, `edit` and `read` on a scratch file in the workspace, and `cleanup`, which removes it. The scripted model checks each tool result and ends the turn early when one is wrong. A failed check reports `conversation-failed` and the step, for example `the resumed startup-check conversation failed at step parallel-tools: ...`. The serving conversations and the production model are never touched. The Supervisor deletes a candidate's facet before its check, never after it: deleting a facet that has just run a conversation reset the whole Supervisor Durable Object in production. The facet stays until the Durable Object is evicted, and a later check of the same commit deletes it first.

## Runtime and Computer

Computer's Worker-shell backend does text operations and host-forwarded Git. Its container backend runs Node, pnpm, TypeScript compilation, tests, and project commands. `computer-integration.md` records the pinned source and image pair.

The harness source is TypeScript, and Dynamic Workers execute Worker-compatible modules, so Computer builds a module map for a labeled harness commit. The Supervisor stores it in an R2 bucket (`MODULE_MAPS`, key `module-maps/<harnessCommit>.json`, written once, never overwritten) and names the serving Worker Loader entry by the commit ID and the serving instance (ADR-0027), so a changed commit or a replaced instance cannot reuse old loaded code or an old model capability, and activating or rolling back loads stored bytes without rebuilding. The Supervisor keeps in SQLite only what an activation decision needs: the active label and epoch, and each generation's state (`candidate`, `failed`, `ready` or `served`, with its facet compatibility), plus the serving state: unproven, proven, or on probation with its fallback, stored as `proven_label` next to the active label. It also appends a record of every submit outcome, activation, rollback and probation result to the same R2 bucket as JSON objects: `history/generations/<label>.json` (overwritten) and `history/events/<epoch>-<kind>.json`, one put per file, written after the SQLite transaction commits. The kinds are `submitted`, `prepared`, `activated`, `rolled-back`, `probation-failed`, and `proven`, which the Supervisor records when a completed turn proves the active generation. Each event names an `actor`: `owner` for the owner API's submit, activate and rollback, `conversation` for the agent's `stumble gen prepare|activate|rollback` (they reach the Supervisor through `GenerationOperations`), and `probation` for the events the Supervisor records itself when a run settles (`proven`, `probation-failed` and its automatic `rolled-back`). A `prepared` event carries the actor that asked for the check. Events written before the Supervisor recorded actors have no `actor`; readers treat them as unknown, and nothing rewrites them. A failed write logs a `generation.history-failed` warning and blocks nothing; the history is a record, not an input to any decision.

## Not built

- automatic promotion, or activating a fallback automatically;
- the agent repairing itself after a broken generation, or a check of its changes beyond the startup check;
- steering a running turn;
- combined project and harness views;
- public signup, teams, roles, or a custom account system; and
- model selection by the owner or the agent. The host picks the model: the owner's ChatGPT subscription once connected, otherwise Workers AI (ADR-0047).

## Behavior to know

Every request except `GET /health` passes HTTP Basic auth and, when it changes state, a same-origin check before it reaches the one Supervisor (ADR-0051, `src/owner-gate.ts`). There is one Supervisor, and the owner API exposes generation submission, activation, and rollback (`src/worker.ts`, `src/routes/owner-api.ts`). The main facet's capabilities are the model route and the host the Supervisor attaches, which relays wakes, records which conversations are running, and hands out project capabilities (`src/facet/index.ts`, `src/supervisor/conversations/host-target.ts`).

A run outlives its browser. `POST /api/projects/{id}/messages` answers 202 once Pi Durable has the message; a message sent while a run is busy is answered after it. The page watches `GET /api/projects/{id}/events`, which starts with the whole committed view and then sends only changes, so a reload or a dropped stream recovers by watching again (after a drop the page resumes from the newest entry it holds, and `GET /api/projects/{id}/entries` loads earlier history). A run that loses its facet instance resumes from the Supervisor's alarm. The Supervisor aborts each run 8 minutes after it starts and ends that run's project capability when it settles, which kills its running commands, while runs in other projects go on (`src/supervisor/conversations/serving.ts`).

A 202 does not prove that the run completed. Only the conversation shows its result.
