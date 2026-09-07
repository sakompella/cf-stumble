# Codex/ChatGPT OAuth web prior art

## Scope and conclusion

This note records the first-party Codex implementation, Pi's implementation, and the
installed Prime Agent implementation. It answers whether the owner-only sign-in can be
moved from a CLI to a Cloudflare Worker. It does **not** claim that the Codex backend is
a supported public OpenAI API.

**Conclusion:** the token exchange and server-side inference calls are technically
implementable in a Worker, but Pi and Prime Agent explicitly keep OAuth login Node-only.
The Codex client ID used by both clients is tied to the localhost callback used by Codex.
The first-party Codex source also says that its callback port is kept in sync with a
redirect-URI allow-list. No OpenAI source found here documents arbitrary public HTTPS
redirect URIs for this client ID. Treat a custom Worker callback as an unconfirmed
compatibility experiment, not as a supported web OAuth integration. The safer v0 is to
keep the login/token holder local and proxy inference, or obtain a supported enterprise
Codex access-token/workload-identity arrangement.

Workers AI (`@cf/zai-org/glm-5.3-flash`, low reasoning) is independent of this flow. It
uses Cloudflare credentials and `env.AI`; ChatGPT sign-in does not grant Workers AI or the
public OpenAI Models API.

## Source map

The URLs below pin source snapshots where possible.

| Source | Evidence |
| --- | --- |
| [OpenAI Codex authentication docs](https://developers.openai.com/codex/auth/) | OpenAI documents ChatGPT sign-in for the desktop app, Codex CLI, and IDE extension; it says the browser returns credentials to Codex, and it documents a localhost callback for the CLI. It separately says that general OpenAI API calls use Platform API keys. See [headless login](https://developers.openai.com/codex/auth/#login-on-headless-devices), [credential storage](https://developers.openai.com/codex/auth/#credential-storage), and [enterprise access tokens](https://developers.openai.com/codex/auth/#use-codex-access-tokens-for-enterprise-automation). |
| [OpenAI Codex source, server.rs](https://github.com/openai/codex/blob/d4dc882998ddf7f3d2b40893ef2f77a5fdfa5715/codex-rs/login/src/server.rs#L60-L177) | First-party callback server: default port `1455`, fallback `1457`, random state, and `http://localhost:{port}/auth/callback`. |
| [OpenAI Codex source, server.rs](https://github.com/openai/codex/blob/d4dc882998ddf7f3d2b40893ef2f77a5fdfa5715/codex-rs/login/src/server.rs#L576-L617) | First-party authorize URL parameters and `S256` PKCE. The source comment says the fallback port must stay in the Codex Hydra redirect allow-list. |
| [OpenAI Codex source, server.rs](https://github.com/openai/codex/blob/d4dc882998ddf7f3d2b40893ef2f77a5fdfa5715/codex-rs/login/src/server.rs#L329-L430) | First-party callback validates state, handles OAuth errors, exchanges the code, and persists tokens. |
| [OpenAI Codex source, pkce.rs](https://github.com/openai/codex/blob/d4dc882998ddf7f3d2b40893ef2f77a5fdfa5715/codex-rs/login/src/pkce.rs#L8-L26) | First-party 64-byte URL-safe verifier and SHA-256 URL-safe challenge. |
| [OpenAI Codex source, manager.rs](https://github.com/openai/codex/blob/d4dc882998ddf7f3d2b40893ef2f77a5fdfa5715/codex-rs/login/src/auth/manager.rs#L1581-L1719) | First-party refresh endpoint and refresh request. Refresh is JSON, and returned fields are optional so the client preserves fields that were not returned. |
| [OpenAI Codex source, bearer_auth_provider.rs](https://github.com/openai/codex/blob/d4dc882998ddf7f3d2b40893ef2f77a5fdfa5715/codex-rs/model-provider/src/bearer_auth_provider.rs#L31-L43) | First-party request headers: `Authorization: Bearer ...` and `ChatGPT-Account-ID`. |
| [OpenAI Codex source, model-provider-info](https://github.com/openai/codex/blob/d4dc882998ddf7f3d2b40893ef2f77a5fdfa5715/codex-rs/model-provider-info/src/lib.rs#L35-L43) | First-party Codex base URL: `https://chatgpt.com/backend-api/codex`. |
| [Pi OAuth source](https://github.com/badlogic/pi-mono/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/ai/src/auth/oauth/openai-codex.ts#L1-L39) | Pi's first-party source in `badlogic/pi-mono`; it labels the flow Node-only, fixes the client ID and localhost callback, and uses the Codex auth/token endpoints. |
| [Pi OAuth source](https://github.com/badlogic/pi-mono/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/ai/src/auth/oauth/openai-codex.ts#L140-L186) | Pi code exchange and refresh are form-encoded and expect `access_token`, `refresh_token`, and `expires_in`. |
| [Pi OAuth source](https://github.com/badlogic/pi-mono/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/ai/src/auth/oauth/openai-codex.ts#L287-L355) | Pi's authorize parameters and exact state check in its local callback server. *(Use the source file's current `4e69...` snapshot above if GitHub normalizes this line anchor.)* |
| [Pi Codex Responses source](https://github.com/badlogic/pi-mono/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/ai/src/api/openai-codex-responses.ts#L633-L645) | Pi resolves its base URL to `/codex/responses`, so its default full endpoint is `https://chatgpt.com/backend-api/codex/responses`. |
| [Pi Codex Responses source](https://github.com/badlogic/pi-mono/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/ai/src/api/openai-codex-responses.ts#L1593-L1631) | Pi sends bearer auth, account ID, `originator`, `OpenAI-Beta: responses=experimental`, SSE headers, and `POST` JSON streaming requests. |
| [Pi AI README, OAuth providers](https://github.com/badlogic/pi-mono/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/ai/README.md#oauth-providers) | Pi says OAuth login flows are Node-only and recommends a server-side proxy/backend for OAuth-based auth from a web app. |
| Installed Prime Agent source | `/nix/store/2vky11d03z3ny9hg5skcrmavz0626zfg-prime-agent-0.9.1/lib/prime-agent/packages/ai/src/utils/oauth/openai-codex.ts` copies the same Node-only localhost flow and form-encoded exchange/refresh. `/nix/store/2vky11d03z3ny9hg5skcrmavz0626zfg-prime-agent-0.9.1/lib/prime-agent/packages/ai/src/providers/openai-codex-responses.ts` copies the Codex endpoint/header/body pattern. This is local product source evidence, not an OpenAI promise. |
| [Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) | Workers provides `crypto.getRandomValues`, `crypto.subtle.digest`, encryption, decryption, key import, and key derivation. |
| [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) | Worker secrets are encrypted text bindings intended for API keys and auth tokens. |
| [Cloudflare SQLite-backed DO storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [DO state](https://developers.cloudflare.com/durable-objects/api/state/) | A Durable Object can persist token ciphertext. SQLite writes are synchronous/atomic; storage transactions exist, and `blockConcurrencyWhile` serializes an async critical section (with a 30-second limit). |
| [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636) and [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749) | PKCE verifier/challenge and OAuth `state`/redirect binding are standard protocol requirements. |

The Pi links are implementation prior art. They are not OpenAI documentation. The
OpenAI source links are first-party implementation evidence. Neither source set is a
public contract for the undocumented `chatgpt.com/backend-api` service.

## Flow and exact request details

### 1. Start login

The server generates, for one login attempt:

- a random PKCE verifier;
- `BASE64URL(SHA-256(verifier))` as the `S256` challenge;
- a random state, bound to the owner's existing application session;
- a short expiration and one-use record containing state and verifier.

The first-party Codex authorize URL includes:

```text
https://auth.openai.com/oauth/authorize
  ?response_type=code
  &client_id=app_EMoamEEZ73f0CkXaXp7hrann
  &redirect_uri=http://localhost:1455/auth/callback
  &scope=openid profile email offline_access api.connectors.read api.connectors.invoke
  &code_challenge=<S256 challenge>
  &code_challenge_method=S256
  &id_token_add_organizations=true
  &codex_cli_simplified_flow=true
  &state=<state>
  &originator=codex_cli_rs
```

Pi uses the same client ID and core parameters, but its scope is
`openid profile email offline_access` and its originator defaults to `pi`. The extra
connector scopes and originator have changed over time; do not treat them as stable API
requirements.

### 2. Callback

The callback receives `code`, `state`, or an OAuth `error`. The server must reject a
missing or mismatched state before exchanging anything. It should atomically consume the
state/verifier record, then exchange the code. A second callback must fail. Do not log the
full callback URL: the query contains the authorization code and state.

The Codex source listens on `127.0.0.1` and uses
`http://localhost:1455/auth/callback` (falling back to `1457`). The authorize and token
requests use the same redirect URI. This exact-match behavior is required by OAuth, and
the first-party source's allow-list comment strongly suggests that the published client ID
is not a general-purpose custom-redirect client.

**Web callback risk:** `https://app.example.com/oauth/callback` is not documented as
accepted for this client ID. A Worker can serve that URI, but OpenAI may reject it as an
unregistered redirect or reject the token exchange because the URI differs from the one
used at authorization. Confirm registration/approval from OpenAI before relying on it.
Do not silently switch to a guessed callback, a ChatGPT cookie, or a copied authorization
code.

### 3. Exchange

Pi's current code posts form data to `https://auth.openai.com/oauth/token`:

```text
grant_type=authorization_code
client_id=app_EMoamEEZ73f0CkXaXp7hrann
code=<code>
code_verifier=<verifier>
redirect_uri=<exact redirect URI>
```

Pi expects `access_token`, `refresh_token`, and numeric `expires_in`. Current first-party
Codex source posts the same logical fields as form data but parses
`id_token`, `access_token`, and `refresh_token`; its token-data code parses JWT claims and
expiration. This is a real implementation difference and evidence that the endpoint
contract can change. A Worker should validate the actual response, retain the ID token
only if needed, and derive account ID from the token claim rather than trusting a browser
parameter.

The current first-party refresh request is JSON:

```json
{
  "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "<refresh token>"
}
```

Pi and Prime Agent currently use `Content-Type: application/x-www-form-urlencoded` for the
same fields. Follow the endpoint behavior verified for the chosen client version, and
expect refresh-token rotation. A successful refresh can return a new refresh token; save
it, or the next refresh can fail. Current Codex source serializes refresh operations with a
single permit and reloads state before refreshing to avoid concurrent refresh races.

### 4. Persist

Codex's documented CLI cache is `~/.codex/auth.json` or an OS credential store. OpenAI's
docs warn that file storage contains access tokens. The current first-party source writes
file storage with mode `0600` and also supports an encrypted local secrets backend. Pi's
credential abstraction serializes `{access, refresh, expires, accountId}` through an
application-owned credential store. None of these is a Durable Object design.

For the Worker, persist **ciphertext only** in the DO. Use a Worker secret as a key-encryption
key and Web Crypto AES-GCM (with a fresh random nonce per record); authenticate the record
version/account ID as additional authenticated data. Encrypt access, refresh, and ID
tokens. Keep the key outside DO storage. Rotate the key by versioning ciphertext and
re-encrypting after successful decryption. Delete ciphertext on logout and implement token
revocation if the endpoint supports the operation.

Encryption is a security requirement for this web deployment recommendation, not an
OpenAI OAuth requirement. Cloudflare's secret binding protects the key, while app-level
encryption prevents a raw DO storage read from yielding a bearer token. Do not put tokens
in browser JavaScript, URL parameters, logs, analytics, or a client cookie.

### 5. Call the Codex backend

Pi's default full URL is:

```text
POST https://chatgpt.com/backend-api/codex/responses
Authorization: Bearer <access token>
chatgpt-account-id: <JWT claim: namespace https://api.openai.com/auth, field chatgpt_account_id>
originator: pi
OpenAI-Beta: responses=experimental
Accept: text/event-stream
Content-Type: application/json
```

The request is a streaming Responses-compatible JSON body. Pi constructs fields including
`model`, `store: false`, `stream: true`, `instructions`, `input`, `text.verbosity`,
`include: ["reasoning.encrypted_content"]`, `prompt_cache_key`, `tool_choice`, and
`parallel_tool_calls`. The body and event protocol are private Codex-client behavior, not
the public OpenAI Responses API contract.

The first-party Codex source uses the same base path and bearer/account-ID headers. Its
provider source identifies `https://chatgpt.com/backend-api/codex`; its Responses endpoint
adds `/responses`. Account ID must come from the verified token, not from an arbitrary
request header supplied by the browser.

### 6. Refresh on use

Before a request, load the encrypted credential and check expiry with a safety window.
If it is near expiry, refresh on the server and atomically replace the full credential.
Serialize this operation per owner. If refresh returns `invalid_grant`, an expired token,
or a reused/invalidated token, clear the credential and require a new sign-in. Preserve
old fields when a refresh response omits them, as current Codex does.

## Cloudflare Worker and Durable Object fit

| Concern | Finding |
| --- | --- |
| PKCE and state generation | Compatible. Workers Web Crypto supplies secure random values and SHA-256. Store verifier server-side only. |
| Token exchange and refresh | Compatible at the HTTP level. A Worker can `fetch()` the HTTPS endpoints from a handler. The exact redirect and token response behavior remains an OpenAI/Codex compatibility risk. |
| Pi/Prime Agent code reuse | Not compatible unchanged. Their callback server imports Node `http` and their docs label OAuth login Node-only. Port the small PKCE/callback logic to Worker APIs instead of importing the CLI module. |
| Callback | Main blocker. A public Worker HTTPS URI is not documented for the existing Codex CLI client ID; localhost `1455`/`1457` is the documented/implemented path. |
| Token storage | Compatible with a per-owner DO, but store encrypted ciphertext and never raw tokens. Use a Worker secret for the encryption key. |
| Refresh races | A DO gives one serialized owner actor. Keep the read/compare/consume/write operations short. Do not hold a SQL transaction open across a network `fetch()`; perform the fetch outside the synchronous transaction, then commit with a version/CAS check or a DO-owned refresh lock. |
| Streaming inference | SSE over Worker `fetch()` is the simplest transport. Pi also has a WebSocket transport, but SSE avoids needing to proxy an undocumented WebSocket protocol. |
| Owner-only enforcement | Enforce Cloudflare Access (exact owner identity) at the app boundary and check the owner/session in Worker code. Also verify the token's expected ChatGPT account/workspace ID after exchange. Do not use a broad `Everyone` policy. |
| Workers AI fallback | Independent and supported through `env.AI.run()` or Cloudflare's OpenAI-compatible endpoint. It does not use ChatGPT OAuth. |

A practical owner-only design, if OpenAI confirms a custom redirect, is:

1. Access-protected `/auth/start` creates the state/verifier record in the owner's DO.
2. The Worker redirects to OpenAI and serves `/auth/callback`.
3. The callback validates and consumes state, exchanges the code server-side, verifies the
   expected account/workspace claim, encrypts and stores the token, and returns a generic
   success page with no token in the URL.
4. The chat route loads the token from the DO, refreshes under the DO's owner lock, and
   proxies the SSE response. The browser receives model output only.

If OpenAI does not approve the HTTPS callback, use a local Codex/Pi/Prime Agent login and
keep its token holder behind a private proxy. Do not expose a public relay to
`chatgpt.com/backend-api`.

## Documented facts vs copied practice

**Documented/first-party:** ChatGPT sign-in is a Codex-client sign-in method; general API
calls use Platform API keys; Codex CLI browser login uses a localhost callback; the current
Codex source uses PKCE/state, `auth.openai.com/oauth/token`, account-scoped bearer headers,
refresh locking, and local credential stores; Workers provide Fetch, Web Crypto, encrypted
secrets, and Durable Object storage.

**Copied or inferred practice:** Pi/Prime Agent's exact client ID, scopes, originator,
`/backend-api/codex/responses` body/header details, form-encoded refresh request,
`expires_in` handling, and using ChatGPT subscription credentials from a custom web Worker.
These are useful compatibility clues, but OpenAI does not document them as a general web
OAuth API. The custom HTTPS callback, encrypted DO schema, Cloudflare Access policy, and
owner account binding are design recommendations in this report, not behavior guaranteed
by OpenAI.
