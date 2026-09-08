# Product overview

> **Superseded for v0:** Handoff decisions 6 and 7 remove R2 cache, recovery, eligibility, and turn-credit behavior from version 0.

cf-stumble is a personal agent that primarily helps with coding and can improve its own main harness. It is inspired by Autolith, Amp's Orbs, NixOS, and Cloudflare's Think. Its main and recovery harnesses both start from Pi-derived forks, running on Cloudflare Durable Objects, Dynamic Workers, Dynamic Worker facets, and Computer.

The product is meant first for one person. It should grow around that person's projects, instructions, working habits, and accumulated context. Coding is its primary use, not a permanent limit on what the harness may help with.

## The two harnesses

The system separates normal work from recovery.

The **main harness** handles the user's work. Its model loop, prompts, tools, policies, and use of files may all change. One generation of the main harness runs in a Dynamic Worker facet.

The **recovery harness** is an immutable Pi-derived fork in the Supervisor Durable Object. It remains close to the Pi base but omits the main harness's connector for requesting Supervisor capabilities. The Supervisor Durable Object is the primary Durable Object for a cf-stumble instance; it is not a facet. It creates or obtains main-harness facets, decides which generation may run, and restores service when a main harness fails.

The interface between the supervisor and a main facet is not settled. Forwarding an ordinary Worker `fetch(Request): Promise<Response>` call is attractive because it uses the platform's native interface and keeps the permanent contract small, and local prototypes show that it works. That evidence does not make `fetch` the only acceptable design.

Generation 0 is the first mutable main harness, initially based closely on Pi. It is not the recovery harness and it is not a special recovery target.

## What the main harness knows and tries to do

For a piece of work, the main harness should receive the user's request, applicable instructions, relevant session history, accumulated context, and access to the files and commands needed for that work. It does not need unrestricted access to every project or to the supervisor's protected state.

Its primary aim is to help the user complete useful work. It may inspect and edit code, run commands, explain results, preserve context, or improve its own harness when that serves the user's goal. Self-modification is a capability, not the purpose of every session.

The recovery harness has a narrower aim: keep a usable main harness available. It needs operational evidence about generations and failures, not the user's full project context.

## Projects and files

In version 0, a project is a GitHub repository that the user connects to cf-stumble. Each project
has one current Pi thread. One Computer workspace contains the harness repository and every
connected project repository in separate directories. The page lists projects in a collapsible left
sidebar.

Starting a fresh thread resets Pi's conversation and compacted context but preserves the project
files. Changing the main-harness generation also preserves both. Project and harness Git histories
remain separate repositories, but their directories share one workspace and are not security
boundaries.

The workspace behaves like a normal development machine. It has unrestricted internet access and
ordinary tools such as `git` and `gh`. GitHub credentials stay in local tool configuration outside
the repositories, and the supervisor does not own or interpret project files or thread state.

## Generations and self-improvement

A project Git commit is just a Git commit. A harness commit becomes a generation only when the Supervisor gives that specific commit a generation label; committing it alone does not activate it.

A new main-harness revision may be submitted as a **generation candidate**. The Supervisor labels the specific harness commit, checks it, records the result against that generation, and decides whether it may run. The exact submission command and transport remain design choices.

The user or mutable main harness may also request that the supervisor activate a specific existing generation or return to an earlier one. Naming a target is not the same as controlling the live system. The supervisor validates the request and performs or rejects the state change; mutable code cannot write the protected generation state directly or bypass recovery checks.

A newly started generation should pass a basic cold-start check before normal use. A generation may later become known good after enough successful real work, but the threshold and evidence are not settled. Twenty successful turns was an illustrative number, not a product requirement.

## Runtime and Computer

Computer's Worker-shell backend is useful for text operations and host-forwarded Git. Its container backend provides Node, pnpm, TypeScript compilation, tests, and project commands. The tested source and image pair are recorded in `computer-integration.md`.

The harness source is TypeScript. Dynamic Workers execute Worker-compatible modules, so Computer
builds a canonical module map before a generation runs. The Supervisor uses each generation's
labeled harness commit ID as its Worker Loader identity, so a changed commit cannot reuse old loaded
code. R2 caches the rebuildable module map under that commit; the cache budget and eviction rule
remain open.

## The first useful version

The first version should provide:

- a streaming conversation with the Pi-based main harness;
- a collapsible left sidebar for connected GitHub projects;
- enough project access to complete a real coding task;
- visible generation and recovery state;
- generation candidate submission and checked activation requests; and
- a small recovery path that can return to usable code.

A broad administration console, configuration editor, metrics dashboard, and browser IDE can wait. The first UI only needs to support the agent conversation and the small amount of generation and recovery information the user needs.

## Open design questions

The main open questions are:

- the supervisor-to-facet interface, including whether normal `fetch` is sufficient;
- what the main harness can request and how the supervisor authenticates and checks it;
- the cold-start check and what counts as success;
- what makes a generation known good;
- what happens to a running turn when its browser disconnects;
- model egress or gateway;
- UI transport;
- recovery limits and timeouts; and
- how executable Worker modules are produced, identified, and retained.

A successful HTTP status does not prove that a streamed turn completed. A stream can fail after sending headers, and a disconnect can leave work unresolved. The implementation should measure those cases before using them as evidence that a generation is reliable.

## Reading the design

Read this overview first. Read `../CONTEXT.md` for precise terms, `../adr/README.md` for settled decisions, `computer-integration.md` for verified Computer evidence, and `slices.md` only when planning implementation work.
