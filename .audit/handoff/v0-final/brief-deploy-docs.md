# Brief: the "Deploy to Cloudflare" button and the user-facing deploy documentation

You are the documentation and prose role for this run (`openai-codex/gpt-5.6-terra`,
`--thinking medium`). This is the last deliverable of version 0, and it is **product**, not release
notes: a stranger with a Cloudflare account and a GitHub account has to get their own instance
running from it.

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/deploy-docs -b work/deploy-docs origin/main
cd /home/aditya/wt/deploy-docs
```

Work only there. Read `.audit/` from `/home/aditya/repos/cf-stumble/.audit/`.

## Read first, in this order

1. `/tmp/cf-stumble-v0-handoff-2026-09-08.md` in full. Step I of "Order of work", the
   "Fresh-account bootstrap" section, and decision 1 are your scope.
2. `/home/aditya/repos/cf-stumble/.audit/v0/realignment-notes.md`, the owner's own words.
3. `/home/aditya/repos/cf-stumble/.audit/v0/evidence/deploy-baseline-smoke.md` and
   `.audit/v0/decision-log.md` entries D75 to D79. **These hold facts you cannot get any other
   way**: every container-image fault this run hit against a real account, and how each was fixed.
4. `docs/agents/design/feature-map.md` and `docs/agents/design/computer-integration.md` on this
   branch, both rewritten today.
5. `wrangler.jsonc`, `containers/computerd.Dockerfile`, `src/access/index.ts`.
6. `docs/agents/writing-style.md`, then the `writing-for-agents` skill. Read the Cloudflare deploy
   button documentation at https://developers.cloudflare.com/workers/platform/deploy-buttons/
   before you write the button markup.

## What to produce

1. **The button.** A "Deploy to Cloudflare" button at the top of `README.md`, pointed at
   `https://github.com/sakompella/cf-stumble` (already public). `AGENTS.md` reserves `README.md`
   for the human, and this brief is the owner's explicit instruction to change it, so keep the
   edit to the button, one sentence of what it does, and a link to the deploy guide. Change nothing
   else in that file.
2. **`docs/deploy.md`**, user-facing. `docs/` outside `docs/agents/` is human-facing documentation,
   which is what this is. It must carry a stranger from nothing to a working owner-only instance:
   - What they need first: a Cloudflare account on the Workers Paid plan (Durable Objects with
     SQLite storage, containers and Worker Loaders are not on the free plan), a GitHub account, and
     a domain in that Cloudflare account if they want Cloudflare Access in front of it.
   - What the button does and what it does not. It forks the repository, provisions the resources
     `wrangler.jsonc` declares, sets up Workers Builds, and deploys. It does **not** configure
     Cloudflare Access, and containers are not in its provisioning list.
   - **The container image.** State plainly that `wrangler.jsonc` names
     `containers/computerd.Dockerfile` rather than a registry image, and why: Cloudflare pulls only
     from the deploying account's own managed registry or from a registry that account has
     configured, so a public image reference fails with `IMAGE_REGISTRY_NOT_CONFIGURED`. Workers
     Builds has docker and does the build and push for them. Say what a user deploying by hand
     needs (docker; podman does not work, and say why in one sentence, from D76).
   - **Cloudflare Access**, step by step, because until it is configured every route refuses:
     create the Zero Trust team, create a self-hosted application for the hostname the Worker
     serves, add one policy that allows the owner's own identity, then set `CF_ACCESS_TEAM_DOMAIN`,
     `CF_ACCESS_AUD` and `CF_ACCESS_OWNER_SUB`. Say where each value comes from, and that
     `CF_ACCESS_OWNER_SUB` is the `sub` claim of the owner's own Access token, which they read
     after their first login. State the fail-closed behavior this run verified against the
     deployment: no credential gives 401, and a credential with no configuration gives 500. That is
     the safe order, not a bug.
   - **Connecting a project.** The workspace is a development machine with `git` and `gh`; the
     owner authorizes GitHub inside it. Explain what is stored where and that no credential passes
     through the browser.
   - **First run.** What the owner sees before any generation exists, and what the bootstrap does
     on the first authenticated request.
   - **Known untested areas**, named honestly. Compaction across a reload is one (handoff decision
     10). Add any other this run recorded as unproven.
   - **Cost.** One short paragraph: what actually costs money here (Workers Paid, container time,
     Workers AI) and how to stop it (delete the Worker, delete the container application).
3. **`HARNESS_REPOSITORY_URL`**: read `src/harness-build.ts`. The harness remote is hardcoded to
   the owner's repository, so a forked deployment would build the owner's code, not the user's.
   Do not change the code. Instead, name this gap in the deploy guide under a clear heading, and
   state exactly what a user must do today, which is to fork and then edit that one constant.
   Report it to your parent as the one product change the guide cannot paper over.

## Rules

- No jargon a stranger will not know. Explain a Durable Object in one clause the first time.
- Every claim about behavior must be one this repository or this run's evidence supports. Where you
  are unsure, write what is unproven rather than a guess. Do not invent a dashboard path you have
  not read in Cloudflare's documentation.
- Run the `writing-for-agents` skill, then `humanizer`, then `unslop` over both documents.
- Plain technical English, short sentences, no long-dash character, no colon as a mid-sentence
  connector.

## The gate

`pnpm verify` green before every commit; the pre-commit hook runs it. Rebase on `origin/main`
before you push and verify again. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/deploy-docs`.
Do not merge.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 450 words:
branch and SHA, the outline of `docs/deploy.md`, every claim you could not support with evidence
and what you wrote instead, what each skill pass changed, and the `HARNESS_REPOSITORY_URL` finding.
