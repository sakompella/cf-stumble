// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The token endpoint's replies are parsed at this boundary.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { isRecord } from "../untrusted.js";

/**
 * The OpenAI sign-in and token endpoints, as "Sign in with ChatGPT" for open-source clients uses
 * them (https://developers.openai.com/siwc/token-sharing-open-source/sign-in). Every destination
 * is fixed here, so nothing a request carries can send a grant or a token anywhere else. Nothing in
 * this module stores, logs, or returns a token to a browser.
 */

const AUTH_ORIGIN = "https://auth.openai.com";

export const AUTHORIZE_ENDPOINT = `${AUTH_ORIGIN}/api/accounts/authorize`;

export const TOKEN_ENDPOINT = `${AUTH_ORIGIN}/api/accounts/oauth/token`;

/**
 * Nothing listens here. A hosted Worker cannot receive a loopback redirect, so the owner (or
 * `tools/chatgpt-connect.mts`) hands back the address the browser ends on, and the Worker reads
 * its parameters without fetching it.
 */
export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";

/** Every first sign-in registers a new client under this id; the callback carries the issued one. */
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";

const AGENT_NAME = "cf-stumble";

const RESOURCE = "https://api.openai.com/v1";

/** The scope that lets the access token spend the owner's ChatGPT plan on the Responses API. */
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";

const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;

const MAX_CALLBACK_BYTES = 4096;

const TOKEN_TIMEOUT_MS = 20_000;

/** A bearer token is visible ASCII with no spaces, which also rules out header injection. */
const BEARER_PATTERN = /^[\u0021-\u007E]{1,16384}$/u;

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function randomSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function pkceChallenge(verifier: string): Effect.Effect<string> {
  return Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).pipe(Effect.map((digest) => base64Url(new Uint8Array(digest))));
}

export type AuthorizeInput = Readonly<{ state: string; verifier: string; agentHostId: string }>;

export function authorizeUrl(input: AuthorizeInput): Effect.Effect<string> {
  return pkceChallenge(input.verifier).pipe(
    Effect.map((challenge) => {
      const url = new URL(AUTHORIZE_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: DYNAMIC_CLIENT_ID,
        agent_name_hint: AGENT_NAME,
        ext_agent_host_id: `urn:uuid:${input.agentHostId}`,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        scope: SCOPE,
        state: input.state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        // Never checked: the ID token is not read. Sent because the flow requires one.
        nonce: randomSecret(),
      }).toString();

      return url.toString();
    }),
  );
}

/** Why a pasted callback address cannot be redeemed. None of these consumes the sign-in. */
export type CallbackProblem =
  | "bad-address"
  | "provider-refused"
  | "wrong-sign-in"
  | "missing-code"
  | "missing-client";

export type Callback = Readonly<{ code: string; clientId: string }>;

/** The one value of a parameter that must appear at most once, or `undefined`. */
function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  const value = values.length === 1 ? values[0]?.trim() : undefined;

  return value === "" ? undefined : value;
}

/** Read the address the browser ended on, without fetching it. */
export function parseCallback(
  pasted: string,
  expectedState: string,
): Result.Result<Callback, CallbackProblem> {
  if (new TextEncoder().encode(pasted).length > MAX_CALLBACK_BYTES) {
    return Result.fail("bad-address");
  }

  const url = URL.parse(pasted.trim());
  const expected = new URL(REDIRECT_URI);

  if (url === null || url.origin !== expected.origin || url.pathname !== expected.pathname) {
    return Result.fail("bad-address");
  }

  const params = url.searchParams;

  if (["code", "state", "client_id", "error"].some((name) => params.getAll(name).length > 1)) {
    return Result.fail("bad-address");
  }

  if (params.has("error")) return Result.fail("provider-refused");

  if (single(params, "state") !== expectedState) return Result.fail("wrong-sign-in");
  const code = single(params, "code");

  if (code === undefined) return Result.fail("missing-code");
  const clientId = single(params, "client_id");

  // A first registration must name the client it issued; `dynamic_agent_client` is not one.
  if (clientId === undefined || clientId === DYNAMIC_CLIENT_ID)
    return Result.fail("missing-client");

  return Result.succeed({ code, clientId });
}

/**
 * Why the token endpoint granted nothing. `rate-limited` (429) and `temporary` (5xx): it was busy
 * and consumed nothing. `ambiguous`: the request may have reached it and rotated a refresh token,
 * so the next refresh may be refused. `rejected`: the grant is refused, for good.
 * `missing-scope`: the grant cannot spend the ChatGPT plan.
 */
export type TokenFailure =
  | "rate-limited"
  | "temporary"
  | "ambiguous"
  | "rejected"
  | "missing-scope";

export class TokenRequestFailed extends Data.TaggedError("TokenRequestFailed")<{
  readonly failure: TokenFailure;
}> {}

export type TokenGrant = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresInMs: number;
}>;

/** The `fetch` the token and model calls use. Injected so a test drives the provider offline. */
export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;

function bearer(value: unknown): string | undefined {
  return typeof value === "string" && BEARER_PATTERN.test(value) ? value : undefined;
}

/** The grant in a 200 reply, or why this route cannot use it. */
export function parseTokenGrant(value: unknown): Result.Result<TokenGrant, TokenFailure> {
  if (!isRecord(value)) return Result.fail("ambiguous");

  const accessToken = bearer(value.access_token);
  const refreshToken = bearer(value.refresh_token);
  const expiresIn = value.expires_in;
  const scope = value.scope;

  if (
    accessToken === undefined ||
    refreshToken === undefined ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    typeof scope !== "string"
  ) {
    return Result.fail("ambiguous");
  }

  if (!scope.split(/\s+/u).includes(DIRECT_TOKEN_SCOPE)) return Result.fail("missing-scope");

  return Result.succeed({ accessToken, refreshToken, expiresInMs: expiresIn * 1000 });
}

function statusFailure(status: number): TokenFailure {
  if (status === 429) return "rate-limited";

  if (status >= 500) return "temporary";

  return status >= 400 ? "rejected" : "ambiguous";
}

/**
 * Post one grant to the fixed token endpoint. A failed reply's body is never read: it may echo a
 * token or a code.
 */
export function requestTokens(
  fetcher: ProviderFetch,
  fields: Readonly<Record<string, string>>,
): Effect.Effect<TokenGrant, TokenRequestFailed> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetcher(TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ ...fields, resource: RESOURCE }).toString(),
          redirect: "manual",
          signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        }),
      catch: () => new TokenRequestFailed({ failure: "ambiguous" }),
    });

    if (response.status !== 200) {
      yield* Effect.promise(() => discardBody(response));

      return yield* new TokenRequestFailed({ failure: statusFailure(response.status) });
    }

    const body: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new TokenRequestFailed({ failure: "ambiguous" }),
    });

    return yield* Effect.fromResult(parseTokenGrant(body)).pipe(
      Effect.mapError((failure) => new TokenRequestFailed({ failure })),
    );
  });
}

/** Stop reading a reply that will not be used. A failing cancel changes nothing for the caller. */
export function discardBody(response: Response): Promise<void> {
  return (response.body?.cancel() ?? Promise.resolve()).catch(() => {
    /* the body was going to be thrown away */
  });
}

export function exchangeFields(callback: Callback, verifier: string) {
  return {
    grant_type: "authorization_code",
    client_id: callback.clientId,
    code: callback.code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  };
}

export function refreshFields(clientId: string, refreshToken: string) {
  return { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken };
}
