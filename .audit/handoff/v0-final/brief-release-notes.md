# Brief: write the version 0 release notes

You are the documentation and prose role (`openai-codex/gpt-5.6-terra`, `--thinking medium`).

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/release-notes -b work/release-notes origin/main
cd /home/aditya/wt/release-notes
```

`docs/release/v0/evidence/` already exists on `origin/main` with four evidence documents copied
there. Write `docs/release/v0/release-notes.md`. Change nothing else except `docs/deploy.md` if
you find a contradiction, and say so if you do.

## Why this file exists

It is the release artifact for done-criterion 1 in `.audit/v0/goal.md`: the exact release commit
passes `pnpm verify`, and the notes identify the SHA, the Computer source and image pair, the model
route, and reproducible deployment commands. Criterion 9 additionally wants the paid probe output
kept with the recording, which is why the evidence is tracked beside these notes now rather than
left in gitignored `.audit/`.

The audience is a person deciding whether to trust and deploy this, not an agent.

## Read first

1. `/tmp/release-facts.md`. Every fact you need, already measured. Do not invent anything beyond it.
2. `docs/release/v0/evidence/*.md`, the four evidence documents you will point at.
3. `docs/deploy.md`, so the notes do not repeat the guide. Link to it instead.
4. `docs/agents/writing-style.md`, then the `writing-for-agents` skill.

## What the notes must contain

- The release SHA, and how to verify it (`pnpm verify`, and what green looks like).
- The pinned Computer source and image pair, and the one thing that surprises people: the pinned
  image is not deployed directly, `containers/computerd.Dockerfile` is.
- The model route: which model, that the host chooses it and a caller cannot.
- Reproducible deployment commands, with the docker requirement stated.
- The settings a deployment needs, and what happens when they are missing.
- What this release can actually do, written as observed behavior with the timings from the
  evidence, each claim pointing at the evidence file that holds its raw output.
- What it cannot do or has not proved. Be complete and specific: the deploy button flow has never
  been run against a clean account, compaction across a reload is untested, the GitHub credential
  lives in the container and is lost when the container recycles (self-healing when `GH_TOKEN` is
  set, needing a human otherwise), and a first build takes five to eight minutes on a half-CPU
  container.
- One short section on the demo recording: it is human work, it is not test evidence, it is not in
  this repository, and where it will live is the owner's decision.
- A cost and cleanup pointer to the guide.

## Rules

Plain technical English, short sentences. No long-dash character. No colon as a mid-sentence
connector; a colon before a list is fine. No marketing voice. Do not claim anything
`/tmp/release-facts.md` and the evidence do not support. Run the `writing-for-agents` skill, then
`humanizer`, then `unslop`.

## The gate

`pnpm format` then `pnpm verify` green before the commit. Rebase on `origin/main` before you push.
Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/release-notes`.
Do not merge.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 350 words: the
branch and SHA, the section list, any claim you could not support and what you wrote instead, what
each pass changed, and the `pnpm verify` line.
