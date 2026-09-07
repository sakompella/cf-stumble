# Arena brief: the session store slice

You are one of four candidates. Another model will judge all four against a rubric you cannot see. Produce the best artifact, not the largest one.

## Read first

1. `/Users/aditya/.agents/skills/poteto-mode/SKILL.md` and follow it. Short declarative sentences. No long-dash characters. No narrating comments in code.
2. `docs/agents/design/feature-map.md`, section `P1: make one coding turn real`. That section is the contract.
3. `docs/agents/adr/0035-use-better-result-only-inside-process-boundaries.md` and `docs/agents/adr/0036-pure-decisions-imperative-shells.md`. Both are binding.
4. `src/supervisor/relay/attempts.ts` and `src/supervisor/generations/decisions.ts`, `generation.ts`, `row.ts`. Match this house style: a store class that creates its table in the constructor, plain row types, pure decision functions kept separate from writes.
5. `src/supervisor/supervisor.ts` for how RPC methods return plain objects.
6. `docs/agents/CONTEXT.md` for the project's terms. Use them.
7. `docs/agents/writing-style.md` if you write prose.

## Build

A session store owned by the Supervisor Durable Object, under `src/supervisor/sessions/`, wired into `src/supervisor/supervisor.ts` as RPC methods.

Requirements, all of them testable in local workerd with no network:

- Sessions are opaque documents keyed by a caller-supplied `sessionId`. The Supervisor does not parse a session's contents. Generation code owns that schema.
- Session state lives outside generation state. Nothing in the session schema names a generation, an activation or a harness commit. A session survives a generation change and a facet replacement.
- Every write carries the caller's expected revision. A mismatch fails with a tagged error and leaves the stored document untouched.
- One session admits one active turn. A second start for the same `sessionId` fails with a conflict error that a caller can distinguish from a stale revision. Finishing or abandoning a turn frees the slot. Two different sessions run at the same time.
- Every Supervisor method returns a plain object with stable string codes, never a `better-result` value. Use `better-result` inside the isolate only.
- Keep pure decisions in their own module and let the store perform the writes.

Tests go in `test/supervisor/sessions/`, following the existing test layout. Cover the stale write, the conflicting turn, the turn release, two concurrent sessions, and survival of a generation change.

## Rules

- Work only inside your assigned worktree. Never touch `/Users/aditya/repos/projects/cf-stumble` directly.
- `pnpm verify` must pass in your worktree before you finish. It runs typecheck, format check, a type-aware lint with `--max-warnings=0`, and the full vitest suite in about eleven seconds. Run `pnpm format` to fix formatting.
- Do not edit existing generation, relay, recovery or startup-check files except for the minimum wiring in `supervisor.ts`.
- Do not commit. Do not deploy. Do not touch `.audit/`.
- No new dependency.

## Deliverables

1. The code and tests in your worktree.
2. `RATIONALE.md` at the root of your worktree, at most 40 lines: the data shape you chose and why, the alternatives you rejected and why, where you put the pure and imperative halves, and anything in the brief you think is wrong.
3. Reply to the parent with `await agent_message.send(<msg>, receiver_role='parent')`, max 150 words: your worktree path, the `pnpm verify` result including test counts, your table's columns in one line, and the single strongest idea in your design.
