# Open questions for the user

- Q1: `openai-codex/gpt-6-astra` is not available on this host (no `astra`, no `gpt-6`).
  I am using `prime-inference/openai/gpt-5.6-terra-pro` (thinking high) as the oracle.
  Is that the right stand-in, or do you want `openai-codex/gpt-5.6-terra` instead?


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
