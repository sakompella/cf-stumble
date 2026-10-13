# Use the owner's ChatGPT subscription through the model route

> **Review:** Agent-only

The model route answers from OpenAI's Responses API with the owner's ChatGPT subscription once the
owner connects it, and from the fixed Workers AI model until then. The owner asked for this on
2026-10-13.

**The Supervisor holds the credential.** The owner signs in with ChatGPT (OpenAI's "Sign in with
ChatGPT" token sharing for open-source agents). The Supervisor registers a new dynamic client for
each sign-in, keeps the PKCE verifier and state of the one pending sign-in, and redeems the code.
It stores the access token, the refresh token, their expiry, and the client id in its SQLite
(`src/chatgpt/credential-store.ts`), where they survive a restart. The Supervisor refreshes the
access token when it is within eight minutes of expiry or when OpenAI refuses it. Concurrent callers
share one refresh, because OpenAI rotates the refresh token and a second redemption of the old one
would revoke the grant.

**The token never leaves the immutable host.** The Supervisor creates the model route with
`props.supervisor` set to its own name. Only the route reads those props; a facet holds the route
stub but cannot see or change them, and holds no Supervisor stub (ADR-0003, ADR-0024). The route
asks the Supervisor for an access token over RPC for each call and sends it only in the
`Authorization` header to OpenAI. No view, log event, RPC result to a facet, or error carries a
token, a code, or the verifier.

**Methods on RPC classes are public API.** Workers RPC exposes every method and accessor on the
prototype of a class that extends `WorkerEntrypoint`, `DurableObject`, or `RpcTarget`. TypeScript's
`private` and `protected` are erased, so a facet holding the route stub could call a `private`
helper by name. Until 2026-10-13 the route's credential lookup was such a helper, and a loaded
generation called it and read the access token through the returned `access()`. A helper on these
classes is a `#private` method or a module function. The lint rule
`cf-stumble/no-typescript-private-rpc-member` (`tools/oxlint/cf-stumble/`) rejects the TypeScript
form, and `test/model-route-rpc-surface.test.ts` probes the route from a loaded generation.

**The fallback is narrow.** With no connection the route calls Workers AI as before. A connection
that needs a reconnect fails every call with `chatgpt-reconnect-required` instead of falling back,
so the owner sees that the subscription stopped answering. A token server that is down fails the
call with `model-unavailable`, unless the stored token is still valid.

**The model is fixed per deployment.** `CHATGPT_MODEL` in `cloudflare.config.ts` names it
(`gpt-6.1-sol`, the model OpenAI's token sharing documentation uses in its examples). The request
uses medium reasoning effort, `store: false` and streaming, and passes system messages as
`instructions`, because the token sharing preview accepts only that shape. A caller still cannot
select the model, effort, or endpoint.

**Disconnect forgets the credential without revoking it.** OpenAI documents no revocation endpoint
for this grant. The owner can revoke it in ChatGPT's settings.

Rejected alternatives:

- **The Supervisor calls OpenAI and streams to the route.** It would put every model call's bytes
  through the Supervisor and tie a turn's lifetime to a Supervisor RPC. The route already owns the
  call; it needs only the token.
- **Pass the token in the route's props.** Props are fixed when the Supervisor creates the stub, so
  a refreshed token would not reach a running turn.
- **Fall back to Workers AI when the grant is refused.** The owner would get a different model's
  answers with no sign that the subscription stopped working.
