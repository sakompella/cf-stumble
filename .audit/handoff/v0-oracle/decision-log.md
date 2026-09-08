# cf-stumble v0 — decision log

## D1 — Oracle model substitution (root agent, unblocked-by-default)
User asked for `openai-codex/gpt-6-astra` effort high. `rlm.find_models` shows no
`astra` and no `gpt-6` selector on this host. Available codex tier:
`gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, plus
`prime-inference/openai/gpt-5.6-terra-pro` and `...-luna-pro`.
Decision: use `prime-inference/openai/gpt-5.6-terra-pro` with thinking=high as the
"expensive oracle" stand-in. Reviewer stays `openai-codex/gpt-5.6-sol` medium as asked.
Question for user: Q1.

## D2 — No HTML
`improve-codebase-architecture` normally emits an HTML report. User said no HTML.
Oracle uses the skill only for vocabulary and lens; deliverables are Markdown in /tmp/cf-stumble-v0/.

## D3 — Artifacts outside the repo
Plans, critique, and this log live in /tmp/cf-stumble-v0/ so nothing untracked lands in the repo.
