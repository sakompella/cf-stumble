# Use the owner's ChatGPT subscription through the model route

> **Review:** Agent-only

The model route answers from OpenAI's Responses API with the owner's ChatGPT subscription once the
owner connects it, and from the fixed Workers AI model until then.

**The Supervisor holds the credential.** The owner signs in with ChatGPT (OpenAI's "Sign in with
ChatGPT" token sharing for open-source agents). The Supervisor registers a new dynamic client for
each sign-in, keeps the PKCE verifier and state of the one pending sign-in, and redeems the code.
It stores the access token, the refresh token, their expiry, and the client id in its SQLite
(`src/chatgpt/credential-store.ts`), where they survive a restart. The Supervisor refreshes the
access token when it is within eight minutes of expiry or when OpenAI refuses it. Concurrent callers
share one refresh, because OpenAI rotates the refresh token and a second redemption of the old one
would revoke the grant. A caller that joins a refresh because OpenAI refused its token never gets
that token back: if the refresh fails and the old token is still the stored one, it gets
`model-unavailable`, as the caller that started the refresh with that token does.

`src/chatgpt/account.ts` models the account as one of three states: disconnected, connected (with
the tokens and the usage limit, if any), or needs a reconnect (with the reason only). One pure
function decides each change, and an event that names a token that is no longer stored changes
nothing. `src/chatgpt/sign-in.ts` does the same for the sign-in (none, pending, or exchanging the
code; the exchanging state lives only in memory). The credential store reads the rows, applies the
change and writes the rows in one `transactionSync`. It keeps the table layout that older Workers
read (`chatgpt_connection`, `chatgpt_login`, `chatgpt_usage_limit`), so a rolled-back Worker still
reads a valid credential. A needs-reconnect row keeps empty strings in the token columns, and the
store reads `chatgpt_usage_limit` only beside a connected row and deletes it on every other write.

**The token never leaves the immutable host.** The Supervisor creates the model route with
`props.supervisor` set to its own name. Only the route reads those props; a facet holds the route
stub but cannot see or change them, and holds no Supervisor stub (ADR-0003, ADR-0024). The route
asks the Supervisor for an access token over RPC for each call and sends it only in the
`Authorization` header to OpenAI. No view, log event, RPC result to a facet, or error carries a
token, a code, or the verifier.

**Methods on RPC classes are public API.** Workers RPC exposes every method and accessor on the
prototype of a class that extends `WorkerEntrypoint`, `DurableObject`, or `RpcTarget`. TypeScript's
`private` and `protected` are erased, so a facet holding the route stub could call a `private`
helper by name. The route's credential lookup was once such a helper, and a loaded
generation called it and read the access token. A helper on these
classes is a `#private` method or a module function. The lint rule
`cf-stumble/no-typescript-private-rpc-member` (`tools/oxlint/cf-stumble/`) rejects the TypeScript
form, and `test/model-route-rpc-surface.test.ts` probes the route from a loaded generation.
The lint rule knows one spelling, so `test/rpc-method-allowlist.test.ts` also lists every method
name on `ModelRoute` and `ProjectRpcTarget` and fails when the prototype chain has a name the list
lacks. A new public method on either class is a new capability for mutable code. Its author adds
the name to the list on purpose, and the reviewer decides whether a facet may call it.

**The fallback is narrow.** With no connection the route calls Workers AI as before and marks the answer's `served` record with `fallback: "chatgpt-not-connected"`; the facet keeps that as a `provider-fallback` diagnostic. It is a field of the `done` event, not an event of its own, because a facet's event check accepts unknown fields but refuses unknown events, so a generation built before it still serves. A connection
that needs a reconnect fails every call with `chatgpt-reconnect-required` instead of falling back,
so the owner sees that the subscription stopped answering. A token server that is down fails the
call with `model-unavailable`, unless the stored token is still valid.

**A usage limit falls back, and says so.** OpenAI can answer HTTP 200 and then stream
`response.failed` with `subscription_sharing_usage_limit_exceeded`, which once failed every turn
until ChatGPT was disconnected. A
call is treated as refused for a usage limit when the provider answers HTTP 429, or its error
code or type is `subscription_sharing_usage_limit_exceeded`, `rate_limit_exceeded`,
`rate_limit_error` or `insufficient_quota`, in the response body or in the stream
(`src/chatgpt/responses.ts`). If nothing of that call reached the caller yet, the route sends one
`provider-fallback` event and answers the call from Workers AI. Generation 0 keeps that event as a
`provider-fallback` diagnostic on the assistant message it ends the call with. The route's `done`
event carries `served`: the provider, model and reasoning effort that answered. The facet writes them as the
message's `provider`, `model` and `providerThinkingLevel`, so the saved thread records which model answered;
without `served` (a Worker from before it) the message keeps `host-model-route`. Once any text or tool call was sent, it never falls back: the call
ends with one `model-unavailable` error, as before, because two providers' halves of one answer are
not one answer. Either way the connection stays connected and the Supervisor records the limit,
but only while the access token the call sent is still the stored, connected one. A call that meets
the limit after a Disconnect, a new sign-in, or a refresh replaced its token records nothing, so an
old account's limit never pauses a new one. A `retry-after` header gives the time it ends, capped
at a week; until then the route skips ChatGPT and falls back without asking. OpenAI names no end for a limit that arrives in the stream, and its
documentation says not to infer one, so the next call asks ChatGPT again and records the limit again
if it still holds. A report without an end does not replace an end that is already known and not
yet reached, so a second call that meets the same limit in the stream keeps the known end. The owner's ChatGPT view shows the limit, with its end when known. Other
refusals, such as `subscription_sharing_user_not_eligible` or
`subscription_sharing_usage_unavailable`, still fail the call.

**The model is fixed per deployment.** `CHATGPT_MODEL` in `infra/worker-settings.ts` names it
(`gpt-6.1-sol`, the model OpenAI's token sharing documentation uses in its examples). The request
uses medium reasoning effort, `store: false` and streaming, and passes system messages as
`instructions`, because the token sharing preview accepts only that shape. It sends the facet's
per-conversation provider session id as `prompt_cache_key`, so the calls of one conversation share a
prompt cache. A caller still cannot select the model, effort, or endpoint.

**Disconnect forgets the credential without revoking it.** OpenAI documents no revocation endpoint
for this grant. The owner can revoke it in ChatGPT's settings.

Rejected alternatives:

- **The Supervisor calls OpenAI and streams to the route.** It would put every model call's bytes
  through the Supervisor and tie a turn's lifetime to a Supervisor RPC. The route already owns the
  call; it needs only the token.
- **Pass the token in the route's props.** Props are fixed when the Supervisor creates the stub, so
  a refreshed token would not reach a running turn.
- **Fall back to Workers AI when the grant is refused.** The owner would get a different model's
  answers with no sign that the subscription stopped working. A usage limit is different: the
  grant still works, the limit ends by itself, and the `provider-fallback` event and the owner's
  view say which model answered.
- **Pause ChatGPT for a fixed time after a limit with no named end.** OpenAI's guidance is to pause
  requests, but any fixed pause invents a reset time. Asking again costs one refused request per
  model call, and ChatGPT answers again as soon as the limit lifts.
