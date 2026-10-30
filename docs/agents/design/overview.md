# Product overview

cf-stumble is a personal agent that primarily helps with coding and can improve its own main harness. It is inspired by Autolith, Amp's Orbs, NixOS, and Cloudflare's Think. Its main harness starts from a Pi-derived fork, running on Cloudflare Durable Objects, Dynamic Workers, Dynamic Worker facets, and Computer.

The product is meant first for one person. It should grow around that person's projects, instructions, working habits, and accumulated context. Coding is its primary use, not a permanent limit on what the harness may help with.

## The two harnesses

The **main harness** handles the user's work. Its model loop, prompts, tools, policies, and use of files may all change. One generation of the main harness runs in a Dynamic Worker facet. Generation 0 is the first one, initially based closely on Pi, and is not a special rollback target.

The **supervisor** is the immutable half. It lives in the Supervisor Durable Object, which is the primary Durable Object for a cf-stumble instance and is not a facet. It creates main-harness facets, decides which generation may run, and refuses a candidate whose startup check fails so the generation that is serving keeps serving.

There is no recovery harness and no automatic repair. Recovery is the owner rolling back to a generation that already ran, which loads a stored module map and rebuilds nothing.

The supervisor calls a facet with ordinary Worker `fetch(Request): Promise<Response>` forwarding (`forwardToFacet` in `src/supervisor/supervisor.ts`). ADR-0003 does not fix this as a permanent contract.

## What the main harness knows and tries to do

For a piece of work, the main harness receives the user's request, applicable instructions, relevant session history, accumulated context, and access to the files and commands the work needs. It does not need unrestricted access to every project or to the supervisor's protected state. Its aim is to help the user finish useful work. It may edit code, run commands, or improve its own harness when that serves the goal, but self-modification is a capability, not the purpose of every session.

The supervisor has a narrower aim: keep a usable main harness available. It needs the generation record and the startup check's result, not the user's project context.

## Projects and files

A project is a GitHub repository that the user connects to cf-stumble. Each project has one current Pi thread. One Computer workspace holds the harness repository and every connected project repository in separate directories. The page lists projects in a collapsible left sidebar.

Starting a fresh thread resets Pi's conversation and compacted context but keeps the project files. Changing the generation keeps both. The Git histories stay separate, but the directories share one workspace and are not security boundaries.

The workspace behaves like a normal development machine, with unrestricted internet access and tools such as `git` and `gh`. GitHub credentials stay in local tool configuration outside the repositories. The supervisor does not own or interpret project files or thread state.

## Generations and self-improvement

A project commit is an ordinary commit. A harness commit becomes a generation only when the Supervisor gives that commit a generation label.

The owner submits a harness commit as a **generation candidate** with `POST /api/generations/submit` (`src/routes/generations.ts`). The Supervisor labels the commit, prepares it, runs the startup check, and records the result against that generation. The owner may then ask the Supervisor to activate a generation or roll back to an earlier one. The Supervisor validates each request and performs or rejects it. Mutable code cannot write protected generation state or bypass those checks. ADR-0024 lets the main harness make the same requests, but that path is not built, so only the owner sends them.

## Runtime and Computer

Computer's Worker-shell backend does text operations and host-forwarded Git. Its container backend runs Node, pnpm, TypeScript compilation, tests, and project commands. `computer-integration.md` records the pinned source and image pair.

The harness source is TypeScript, and Dynamic Workers execute Worker-compatible modules, so Computer builds a module map for a labeled harness commit. The Supervisor stores it in its own SQLite under that commit and uses the commit ID as the Worker Loader identity, so a changed commit cannot reuse old loaded code, and activating or rolling back loads stored bytes without rebuilding.

## Not built

- automatic promotion, or activating a fallback automatically;
- the agent repairing itself, submitting generations, or approving changes;
- reconnect, resume, steering, and background turns;
- combined project and harness views;
- public signup, teams, roles, or a custom account system; and
- model selection by the owner or the agent. The host picks the model: the owner's ChatGPT subscription once connected, otherwise Workers AI (ADR-0047).

## Behavior to know

The Worker has no authentication. Every request reaches the one Supervisor, and the owner API exposes generation submission, activation, and rollback (`src/worker.ts`, `src/routes/owner-api.ts`). The main facet's only capability is the model route (`src/facet/index.ts`).

A running turn does not outlive its browser. While a turn is open the Supervisor writes an empty line on the stream every 2 s, so it hears of a disconnect within about 4 s even while a command runs. It then settles the turn as `cancelled`, frees the lease, and ends the turn's capability, which kills its running commands (`src/supervisor/projects/turn-stream.ts`).

A successful HTTP status does not prove that a streamed turn completed. A stream can fail after sending headers, and a disconnect can leave work unresolved. ADR-0037 credits only terminal, saved success.
