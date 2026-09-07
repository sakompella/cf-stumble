# Design questions for the owner

This is an untracked running list. It records product and preference choices that evidence cannot settle. Agents must test observable questions themselves and keep them out of this file.

The owner has changed direction during the project. Treat every old answer as evidence, not authority. Before adding a question, inspect the current feature map, ADRs, implementation, the original Claude export, and relevant Pi sessions. When the records disagree or the search is large, delegate the mining and save the exact source pointer here.

Work continues under the current default unless an answer changes the plan. A question blocks work only when every reversible path would waste substantial effort or when the next action is irreversible.

Historical sources:

- Original Claude export: `/Users/aditya/Documents/Codex/2026-05-20/how-can-i-have-codex-access/claude-desktop-export/unknown-Becoming-a-Cloudflare-SWE-intern-6d218bb2.md`
- Pi session that produced the main-harness plan and Pi vendoring: `01a05aeb-2bb2-75ff-9ac6-089b7731f66b`
- Current release scope: `docs/agents/design/feature-map.md`
- Current approved decisions: `docs/agents/adr/README.md`

## Open

### Q1. Does each tenant eventually own a harness repository, or do tenants share one harness and keep personalization in durable state?

Current default: version 0 has one tenant and one harness repository. The tenant boundary keeps conversations, project context, and credentials outside harness code. A second tenant receives isolated durable state but may still run the shared harness.

Why the answer matters: separate harness repositories make each agent's code genuinely personal, but they add repository credentials, build authority, cache privacy, and update distribution. A shared harness keeps multi-user support small.

Evidence: `docs/agents/design/feature-map.md`, sections "What version 0 is" and "Tenant and client routing". Neither the Claude export nor Pi session `01a05aeb-2bb2-75ff-9ac6-089b7731f66b` contains a user choice about harness ownership across tenants. The old discussions are single-user.

### Q2. What should the agent be allowed to change about itself after version 0?

Current default: the owner submits, activates, and rolls back harness commits. The model has no generation-control tool. Agent-authored proposals, replay approval, and automatic promotion remain postponed.

Why the answer matters: this decides whether self-modification is a core product action, an owner development workflow, or only an architectural capability.

Evidence: `docs/agents/design/feature-map.md`, "Fixed limits" and "Deliberately postponed". Claude export messages 29, 31, 71, and 72 move from full code self-modification to doubt that code changes are needed at all. No later user message resolves it.

### Q5. Is the first public artifact a private personal tool, an invite-only demo, or a service other people can use?

Current default: deploy one tenant behind an Access policy that allows only the owner. Tenant routing supports another invited identity without changing the harness, but there is no signup, billing, tenant administration, or deletion flow.

Why the answer matters: the answer determines whether user-owned credentials, quotas, repository onboarding, and account deletion belong after version 0 or remain out permanently.

Evidence: `docs/agents/design/feature-map.md`, "Tenant and client routing" and "Deliberately postponed". Claude export messages 69 and 73 describe a personal orb and the owner's laptop setup as the problem. Public service ideas came from assistant suggestions.

### Q6. Where should generation controls live on the application page?

Current default: the streaming Pi conversation is primary, and a collapsible left sidebar selects
GitHub projects. Generation and recovery controls remain on the same application page, but the owner
has not chosen whether they stay visible, use a drawer, or live in another secondary view.

Why the answer matters: hiding rollback too deeply can make recovery difficult, while giving
generation controls equal space with the conversation makes normal project work harder to scan.

Evidence: ADRs 0037 and 0038 and `docs/agents/design/feature-map.md` record streaming and project
navigation. They do not decide the placement of generation controls.

### Q7. After manual rollback works, should recovery ever activate a fallback automatically?

Current default: no. Version 0 records failures and gives the owner a rollback action. The existing recovery state machine does not activate or repair code.

Why the answer matters: automatic fallback changes availability, authority, evidence thresholds, and what a client sees during a failed turn.

Evidence: `docs/agents/design/feature-map.md`, P3. ADR-0032 bounds recovery work but keeps activation under generation control. The Pi session proposed automatic fallback, but that was an agent design and the current feature map supersedes it. Claude export messages 97 and 98 end with a user-controlled reset rather than an automatic recovery agent.

## Answered

### Q3. Should two clients ever collaborate in the same live session?

Answer: version 0 presents one current Pi thread per project. One project accepts one active turn.
Starting a fresh thread replaces conversation and compacted context while preserving project files.
Live collaboration and parallel threads within one project remain deferred.

Recorded after the owner UX review. ADR-0038 and `docs/agents/design/feature-map.md` record the
decision.

### Q4. Which model and payment path should the first deployment use?

Answer: version 0 uses one fixed Workers AI route outside the mutable facet. The owner prefers OpenAI. Codex and Pi support ChatGPT sign-in for local CLI harnesses through a localhost callback. The available prior art does not establish that their hard-coded client supports an arbitrary HTTPS callback for a Worker, so version 0 does not depend on that unconfirmed integration.

Recorded 2026-09-02. Updated `docs/agents/design/feature-map.md`. Research: `.audit/research/openai-chatgpt-login-workers-ai.md` and `.audit/research/codex-oauth-web-prior-art.md`.
