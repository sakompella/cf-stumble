# Open questions for the user

- ~~Q1~~ CLOSED by the owner: `gpt-6-astra` exists and must be forced. The oracle ran as a
  `prime-agent --model openai-codex/gpt-6-astra --thinking high` shell-out.


## v0 product preferences from the architecture review

These do not reopen the approved shared-workspace, Pi, direct-command, or manual-rollback decisions. Continue reversible implementation with the defaults below. Platform capability, runtime timing, token persistence, and container concurrency are experiments in the roadmap, not questions for the owner.

### Q2. Is a one-time gh device authorization acceptable for connecting GitHub repositories?

Default. The owner authorizes gh in the shared workspace through GitHub's verification page, then selects or names repositories the credential can access. The application exposes only the verification URL/code and connection status. It never requests an access token in a browser field.

Why this is yours. A custom GitHub App or OAuth callback can offer a different permission and onboarding experience, but it adds application setup and credential lifecycle work. ADR-0039 requires separate repository authorization and local gh credentials; it does not select this UX. T6 verifies provider support rather than asking you to guess it.

### Q3. On disconnect or explicit cancellation, should the app keep completed partial conversation messages?

Default. Cancel the running turn, stop further model/tool dispatch, keep valid partial Pi messages when the server can save them under the original lease, and mark the outcome cancelled. Never award success credit to unfinished work. Keep any save already committed. Files changed before cancellation remain, as on a normal development machine.

Why this is yours. Preserving partial conversation makes earlier tool effects explainable. Discarding it gives a cleaner conversation but can leave file changes with no transcript. No background-turn or reconnect feature is implied. T9 measures disconnect propagation independently.

### Q4. Should generation controls use a compact drawer or stay visible beside the conversation?

Default. Keep the active generation visible and put submission, activation, rollback, and the latest report in a compact drawer on the same page. Keep rollback reachable when a turn fails.

Why this is yours. This is an attention and layout preference. It corresponds to Q6 in `.audit/design-questions.md`. T10 can proceed with the drawer without changing any backend interface.

### Q5. Where may the v0 recording be published, and may it show repository contents?

Default. Record only a disposable demo repository with no personal code, credentials, or identity details. Retain the recording locally and prepare release notes. Do not publish outside the approved audience until you choose a destination.

Why this is yours. The feature map asks for publication, but neither the audience nor permission to expose real project content is specified. This blocks publication only, not implementation or private validation.

### Q6. Is the currently implemented Workers AI model acceptable if it passes the coding demo?

Default. Keep the one fixed `@cf/zai-org/glm-5.3-flash` route while proving its streaming and coding behavior. Do not add model selection or subscription login.

Why this is yours. `.audit/design-questions.md` records a preference for OpenAI, while `src/model-route.ts` selects a different provider's model through Workers AI. T4 must observe whether that route satisfies the required interface. Whether the provider preference itself is a release requirement is your decision.


## Q7 (root agent, needs an explicit yes) — may an unsupervised agent spend paid Cloudflare budget?

T1 acceptance criteria 4 and 5 require a real paid probe: deploy a candidate facet, have Computer
build a module map, load it under the commit-named Worker Loader, cold-start it, run a container
command, write a durable file, and restart or evict the host. The roadmap itself calls for "an
approved disposable paid environment", and its criterion 6 says missing paid authorization means
BLOCKED, not passed.

Tonight I dispatched the LOCAL half of T1 only, with paid spend explicitly forbidden. Criteria 4, 5
and the pin-replacement check are recorded as blocked.

What I need from you:
1. May a worker run the paid probe unsupervised, and against which account or disposable environment?
2. Is there a spend ceiling it must respect?
3. Should it use the pinned Computer pair, or first check for a supported release (the
   `computer-integration.md` upgrade follow-up)?

Until you answer, the critical path stops after the local clean-build fix. Every other wave-1 task
is local and continues.


### Q7 addendum — the cheapest paid probe, worth answering first

Independent of the full T1b gate, ONE five-minute probe would de-risk T4 tonight:
`env.AI.run("@cf/zai-org/glm-5.3-flash", { stream: true, tools: [...] })` — do text deltas and
tool-call fragments arrive incrementally? If not, Q6 reopens and T4's provider-facing half is
rewritten. If yes, T4's design is confirmed. Approving just this one probe is much cheaper than
approving the whole paid gate.


### Q7 precondition checklist (from review B8) — please answer these, not just "yes"

Eight tasks spend money or touch your accounts: T1b, T3.4, T4, T6, T8 (an R2 **deletion** lifecycle
rule on a real bucket), T9, T10, T12 (full deploy, plus publishing a recording — the only step with
irreversible **disclosure**). None may run unsupervised until these are written down:

1. **Which account or environment?** Name a non-production Cloudflare account, or a prefix for this
   run's Worker names, R2 bucket, Durable Object namespaces and Container, so nothing overwrites a
   resource you care about. "An approved disposable paid environment" is not yet a name.
2. **What is the spend cap** per task or for the run? Every paid task should stop on the first paid
   failure and record it; only T1.6 says that today.
3. **Which GitHub account and repositories** may probes clone and push to? These must be disposable
   repos under a throwaway owner. May any probe push to a repository you care about? (Default: no.)
4. **The R2 lifecycle rule in T8 deletes objects.** Confirm the bucket it may act on.
5. **Publication (Q5) stays blocked** until you name a destination.


### Q7, what the paid probe must actually measure (from the merged T1a evidence)

If you approve a paid run, T1b should measure exactly this list and nothing else. It is derived from
the harness-build preconditions T1a wrote into `docs/agents/design/computer-integration.md`, which is
tracked and worth reading:

1. **pnpm bootstrap.** `package.json` pins `"packageManager": "pnpm@11.18.0"` while the container
   ships 11.24.0, so the container DOWNLOADS pnpm 11.18.0 before `pnpm install` starts. Never run.
2. **Registry throughput.** The install is 186 packages, ~145 MB compressed and ~496 MB unpacked,
   with `@cloudflare/workerd-linux-64` alone at 38 MB / 152 MB. Existing paid evidence is one
   `pnpm add is-odd@3.0.1`.
3. **Cold-build timeout.** 13 s locally on a fast network with an empty store. T1a recommends 900 s
   for the container until measured. T9 and T12 inherit whatever this turns out to be.
4. **Disk.** 491 MB build directory plus 598 MB cold store, measured locally. Check the container's
   budget.
5. **`tar`.** The checkout step runs `git archive` and `tar`. The recorded container toolchain lists
   Git, Node, pnpm and FUSE — it does NOT record `tar`.
6. **Outbound HTTPS to `github.com`.** The provision step runs `git clone --no-checkout` and
   `git fetch`. The recorded network evidence covers the npm registry only.
7. **Two clean COMPUTER builds of one labeled commit produce identical maps.** Locally this already
   holds: sha256 `387ed749...`, twice, on merged main. Goal criterion 7 needs it in a container.

Items 1, 5 and 6 are the ones most likely to fail outright, and each is cheap to test first.


### Q7 addendum 2 — a third cheap thing the paid probe must check first (found by T6a)

`gh` is NOT in the recorded Computer toolchain. `docs/agents/design/computer-integration.md` lists
Node 22.23.2, pnpm 11.24.0, Git and FUSE from the 2026-08-29 paid run. It never mentions `gh`.
T6a's whole connection path runs `gh auth login --with-token` and `gh auth setup-git`. If `gh` is
absent from the pinned image, no repository can be connected and ADR-0039 needs an install step.
T6a refused to guess and reports `tooling-missing` in that case.

So the cheapest three probes, in order, are now:
1. `gh --version` in the container (T6a's entire path depends on it)
2. `tar` present (the checkout step runs `git archive` + `tar`)
3. outbound HTTPS to `github.com` (provisioning runs `git clone --no-checkout` and `git fetch`)
Each is seconds of work and each can invalidate a whole task if it fails.
