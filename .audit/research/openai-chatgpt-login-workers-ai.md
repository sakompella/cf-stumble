# ChatGPT sign-in, OpenAI models, and Cloudflare Workers (v0 research)

**Scope.** This report uses only first-party OpenAI and Cloudflare documentation. URLs were checked 2026-06-16.

## Key conclusion (corrected)

OpenAI does support ChatGPT/Codex OAuth for **Codex clients and third-party harnesses that implement the Codex integration**, including Pi. This is different from OAuth for the public OpenAI Platform Models API. Pi's official source implements PKCE against `auth.openai.com`, exchanges the authorization code for access/refresh tokens, extracts the ChatGPT account ID from the token, and calls the Codex Responses backend at `https://chatgpt.com/backend-api` with a bearer token plus `chatgpt-account-id`. The source labels the flow “only intended for CLI use, not browser environments.”

*Sources:* [OpenAI Codex authentication](https://developers.openai.com/codex/auth/) documents ChatGPT sign-in for Codex and distinguishes it from API-key access; [Pi OAuth implementation](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/auth/oauth/openai-codex.ts); [Pi Codex Responses client](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/api/openai-codex-responses.ts); [Pi provider registration](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/openai-codex.ts).

Therefore the precise answer is: **yes, a Worker can technically implement the same Codex OAuth client flow and call the Codex backend, but this is not the public OpenAI API and is not a generally supported browser/web-app OAuth architecture.** The official Pi library says OAuth login flows are Node-only and recommends a server-side proxy/backend for OAuth from a web app: [Pi AI README, OAuth Providers](https://github.com/badlogic/pi-mono/blob/main/packages/ai/README.md#oauth-providers). Treat this as a private, owner-only v0 integration, not a multi-user product entitlement. It still requires a qualifying ChatGPT subscription/workspace and remains subject to Codex usage limits and policy; it does not create a free API billing account.

OpenAI's Codex documentation also says enterprise Codex access tokens are intended for trusted non-interactive Codex local workflows and says: “For general OpenAI API calls, continue to use Platform API keys.” Public OpenAI API calls remain API-key based: [OpenAI API authentication](https://platform.openai.com/docs/api-reference/authentication), [OpenAI API keys](https://platform.openai.com/api-keys).

### What the supported third-party flow does

Pi's source uses authorization-code + PKCE with scope `openid profile email offline_access`, a localhost callback (`http://localhost:1455/auth/callback`), and the OpenAI Codex client ID. It posts the code/verifier to `https://auth.openai.com/oauth/token`, stores access and refresh tokens, refreshes through the same endpoint, and sends requests to the Codex backend. Pi stores OAuth credentials in its credential store and warns that OAuth login is Node-only. These implementation details are evidence of the Codex client contract, not a promise that arbitrary deployments may impersonate Pi; obtain any needed OpenAI authorization before shipping a commercial integration.

### Could a Cloudflare Worker safely use it?

For an owner-only v0, a Worker can host the PKCE callback (use a Worker HTTPS callback rather than Pi's localhost callback), keep the refresh token in encrypted server-side storage, perform refresh server-side, and call only the Codex backend. Do not expose access/refresh tokens to browser JavaScript, put them in cookies/URLs/logs, or accept arbitrary user-supplied account IDs. Bind the callback and inference routes to the owner's Cloudflare Access identity, validate OAuth `state` and PKCE verifier, rotate/overwrite refresh tokens atomically, and provide logout/revocation and rate limits.

This remains a higher-risk compatibility integration: Cloudflare Workers is not the Node environment targeted by Pi's OAuth module, and the `chatgpt.com/backend-api` endpoint is distinct from the documented public API. Do not call undocumented endpoints for a public multi-user service or promise ChatGPT-login support as a substitute for Platform API billing.

## Contrast: Workers AI

Workers AI is Cloudflare's model inference product, not a way to spend a ChatGPT subscription. A Worker can use a native `env.AI` binding (`{ "ai": { "binding": "AI" } }`) and call `env.AI.run(...)`: [Workers AI Workers bindings](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/). The REST option requires a Cloudflare account ID and a Cloudflare API token: [Workers AI REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/). Cloudflare also offers OpenAI-compatible *endpoint syntax*; it changes the base URL and model name, but authentication is still Cloudflare credentials: [OpenAI-compatible Workers AI endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/).

Thus Workers AI can avoid an OpenAI key, but it does not avoid Cloudflare account authorization/quotas or make OpenAI models available. “OpenAI-compatible” describes the client protocol, not entitlement or provider identity.

## Viable v0 architectures

1. **Cloudflare-only:** Worker + `env.AI` binding. Protect the UI/API with Access. This is the simplest no-OpenAI-key prototype.
2. **OpenAI-backed service:** Worker calls the OpenAI Responses/Models API with a server-side Platform API key stored as a Worker secret, with rate limits and spend limits. Never send that key to the browser. See [Responses API reference](https://platform.openai.com/docs/api-reference/responses) and [API authentication](https://platform.openai.com/docs/api-reference/authentication).
3. **User-owned credentials (BYOK):** A user supplies their own Platform API key to a tightly scoped request/session. Prefer not persisting it; do not log it; explain that usage is billed to that user's Platform organization. This is not ChatGPT-login reuse.
4. **Owner-only Codex OAuth:** Implement the documented-by-Pi Codex PKCE/token flow in a private Worker, or keep Pi as the OAuth/token holder and proxy requests. This can avoid a Platform API key, but it calls the Codex backend, not the public API. Enforce owner-only Access and strong token handling; do not expose it as a general relay.
5. **Supported enterprise automation (only if eligible):** Use OpenAI's documented Codex access-token/workload-identity mechanisms for trusted Codex local automation, not general model API calls. Confirm enterprise permissions, token scope, rotation, and Cloudflare egress/security before considering a Worker; the OpenAI docs direct general API calls to Platform keys.

## Credential and security constraints

* ChatGPT browser cookies are session credentials for ChatGPT web. A Worker cannot see a user's browser cookie unless the application deliberately exfiltrates it; doing so is unsafe and is not the documented API auth flow.
* OAuth authorization-code/PKCE can authenticate a user's own application only when the provider exposes a supported OAuth client and token audience. The Codex browser callback is documented for the Codex app/CLI/IDE, not as a public OpenAI Models API OAuth integration.
* Do not put provider credentials in client JavaScript, URL parameters, logs, Durable Object state, or source control. Bind secrets at deployment and limit endpoint access, input size, concurrency, and spend.
* Access controls authenticate who may invoke the Worker; they do not grant OpenAI model entitlement or pay OpenAI bills.

## Correct owner-only Cloudflare Access setup

Use a **custom hostname on a Cloudflare-managed domain**, not a claim that a ChatGPT login will authorize the Worker:

1. In **Zero Trust → Access controls → Applications**, create **Self-hosted and private → Add public hostname** for the Worker deployment hostname (the domain must belong to an active Cloudflare zone).
2. Create one **Allow** policy with **Include → Email** and the owner's exact email address (or Include → Emails ending in the owner's controlled domain). Leave out `Everyone`; Access is deny-by-default.
3. Enable only the needed identity provider (Cloudflare One-time PIN or the owner's OIDC/SAML IdP), and optionally require MFA. Do not add a broad second Allow policy. Avoid Bypass: Cloudflare documents that Bypass disables Access enforcement and logging.
4. Route the custom hostname to the Worker, test an owner login and a different account, and keep the Worker itself authorization-aware for any non-browser/API path.

Cloudflare's setup explicitly requires an active Cloudflare domain, says applications are deny-by-default, and says an Allow-policy match is required: [Publish a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/). Policy semantics and the exact `Allow / Include / Email` selectors are documented here: [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/). Access protects the deployment; it does not proxy or convert a ChatGPT session into an OpenAI API key.

## Decision

For v0, choose Workers AI if the product can use Cloudflare-hosted models. If OpenAI models are required, obtain a Platform API key/organization (or have users BYOK) and keep it server-side. Do not build around scraping ChatGPT, forwarding ChatGPT cookies, or undocumented Codex endpoints.
