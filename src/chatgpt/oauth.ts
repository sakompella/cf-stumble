import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const AUTH_ORIGIN = "https://auth.openai.com";

export const AUTHORIZE_ENDPOINT = `${AUTH_ORIGIN}/api/accounts/authorize`;

export const TOKEN_ENDPOINT = `${AUTH_ORIGIN}/api/accounts/oauth/token`;

export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";

const DYNAMIC_CLIENT_ID = "dynamic_agent_client";

const AGENT_NAME = "cf-stumble";

const RESOURCE = "https://api.openai.com/v1";

const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";

const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;

const MAX_CALLBACK_BYTES = 4096;

const TOKEN_TIMEOUT_MS = 20_000;

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
        nonce: randomSecret(),
      }).toString();

      return url.toString();
    }),
  );
}

export type CallbackProblem =
  | "bad-address"
  | "provider-refused"
  | "wrong-sign-in"
  | "missing-code"
  | "missing-client";

export type Callback = Readonly<{ code: string; clientId: string }>;

function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  const value = values.length === 1 ? values[0]?.trim() : undefined;

  return value === "" ? undefined : value;
}

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

  if (clientId === undefined || clientId === DYNAMIC_CLIENT_ID)
    return Result.fail("missing-client");

  return Result.succeed({ code, clientId });
}

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

export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;

const Bearer = Schema.String.check(Schema.isPattern(BEARER_PATTERN));

const TokenReply = Schema.Struct({
  access_token: Bearer,
  refresh_token: Bearer,
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  scope: Schema.String,
});

const decodeTokenReply = Schema.decodeUnknownOption(Schema.fromJsonString(TokenReply));

export function parseTokenGrant(body: string): Result.Result<TokenGrant, TokenFailure> {
  const reply = decodeTokenReply(body);

  if (Option.isNone(reply)) return Result.fail("ambiguous");
  const { access_token, refresh_token, expires_in, scope } = reply.value;

  if (!scope.split(/\s+/u).includes(DIRECT_TOKEN_SCOPE)) return Result.fail("missing-scope");

  return Result.succeed({
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresInMs: expires_in * 1000,
  });
}

function statusFailure(status: number): TokenFailure {
  if (status === 429) return "rate-limited";

  if (status >= 500) return "temporary";

  return status >= 400 ? "rejected" : "ambiguous";
}

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

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new TokenRequestFailed({ failure: "ambiguous" }),
    });

    return yield* Effect.fromResult(parseTokenGrant(body)).pipe(
      Effect.mapError((failure) => new TokenRequestFailed({ failure })),
    );
  });
}

export function discardBody(response: Response): Promise<void> {
  return (response.body?.cancel() ?? Promise.resolve()).catch(() => {});
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
