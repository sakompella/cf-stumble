import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { logEvent } from "../diagnostics.js";
import type { ModelRouteRequest, ModelStreamEvent } from "../model-route.js";
import { finishedTurn, ProviderStreamAccumulator } from "../model-route-stream.js";
import {
  ModelTurnFailed,
  modelUnavailable,
  pumpSseStream,
  type ModelTurnAnswer,
} from "../model-route-turn.js";
import type { ChatGPTAccess } from "./connection-view.js";
import { discardBody, type ProviderFetch } from "./oauth.js";
import {
  isUsageLimit,
  providerError,
  RESPONSES_ENDPOINT,
  ResponsesStreamReader,
  responsesRequest,
  retryAt,
  type ProviderError,
} from "./responses.js";

/**
 * What the model route needs from the Supervisor that holds the owner's credential: the token to
 * send now, a way to report one the provider refused after a refresh, and a way to report the
 * usage limit a token met, with the time it ends when the provider named one. All are Supervisor
 * RPC calls; the token reaches this isolate and the provider, never a facet.
 */
export type ChatGPTCredential = Readonly<{
  access(rejected?: string): Promise<ChatGPTAccess>;
  markRefused(accessToken: string): Promise<void>;
  markUsageLimited(accessToken: string, limitedUntil: number | null): Promise<void>;
}>;

/** No ChatGPT credential is connected, so the route answers from Workers AI instead. */
export class ChatGPTNotConnected extends Data.TaggedError("ChatGPTNotConnected") {}

/**
 * The owner's plan refused this call for a usage limit before any of its output reached the
 * caller, so the route can still answer it from Workers AI (ADR-0047). `limitedUntil` is when the
 * limit ends, or `null` when the provider did not say.
 */
export class ChatGPTUsageLimited extends Data.TaggedError("ChatGPTUsageLimited")<{
  readonly limitedUntil: number | null;
}> {}

type ChatGPTRefusal = ModelTurnFailed | ChatGPTNotConnected | ChatGPTUsageLimited;

export type ChatGPTTurnInput = Readonly<{
  credential: ChatGPTCredential;
  fetcher: ProviderFetch;
  model: string;
}>;

const reconnectRequired = (): ModelTurnFailed =>
  new ModelTurnFailed({ code: "chatgpt-reconnect-required" });

/** A longer error body is not parsed, and only a parsed body's error type and code reach the log. */
const MAX_ERROR_BODY_BYTES = 4096;

function accessToken(
  credential: ChatGPTCredential,
  rejected?: string,
): Effect.Effect<string, ChatGPTRefusal> {
  return Effect.tryPromise({
    try: () => credential.access(rejected),
    catch: modelUnavailable,
  }).pipe(
    Effect.flatMap((access): Effect.Effect<string, ChatGPTRefusal> => {
      switch (access.kind) {
        case "ready":
          return Effect.succeed(access.accessToken);
        case "not-connected":
          return Effect.fail(new ChatGPTNotConnected());
        case "usage-limited":
          return Effect.fail(new ChatGPTUsageLimited({ limitedUntil: access.limitedUntil }));
        case "reconnect-required":
          return Effect.fail(reconnectRequired());
        case "unavailable":
          return Effect.fail(modelUnavailable());
        default: {
          const exhaustive: never = access;

          return exhaustive;
        }
      }
    }),
  );
}

/** The error in a refusal's body, without its message. The rest of the body may echo the request. */
function errorOf(response: Response): Effect.Effect<ProviderError> {
  return Effect.promise(async () => {
    try {
      const text = await response.text();

      return providerError(text.length > MAX_ERROR_BODY_BYTES ? null : JSON.parse(text));
    } catch {
      return providerError(null);
    }
  });
}

/**
 * End a call the provider refused, logging only the HTTP status and the error's type and code. A
 * usage limit is reported to the Supervisor either way, so later calls can skip ChatGPT; only one
 * that reached the caller with nothing yet fails with {@link ChatGPTUsageLimited}, because the
 * route must never splice a second provider's answer onto a first one's partial output.
 */
function refused(
  credential: ChatGPTCredential,
  token: string,
  outcome: "http-error" | "stream-failed",
  response: Response,
  error: ProviderError,
  outputSent: boolean,
): Effect.Effect<never, ChatGPTRefusal> {
  const fields = { outcome, status: response.status, type: error.type, code: error.code };

  if (!isUsageLimit(response.status, error)) {
    logEvent("error", "chatgpt.model-call", fields);

    return Effect.fail(modelUnavailable());
  }

  const limitedUntil = retryAt(response.headers.get("retry-after"), Date.now());
  const limitFields = { ...fields, fallback: !outputSent };

  logEvent(
    outputSent ? "error" : "warn",
    "chatgpt.model-call",
    limitedUntil === null ? limitFields : { ...limitFields, limitedUntil },
  );

  return Effect.promise(() =>
    credential.markUsageLimited(token, limitedUntil).catch(() => {
      /* the limit goes unrecorded; the next call asks ChatGPT and meets it again */
    }),
  ).pipe(
    Effect.andThen(
      Effect.fail(outputSent ? modelUnavailable() : new ChatGPTUsageLimited({ limitedUntil })),
    ),
  );
}

/**
 * One Responses call. A redirect is never followed, because it could carry the token elsewhere.
 * The access token goes in the `Authorization` header and nowhere else.
 */
function send(
  input: ChatGPTTurnInput,
  body: string,
  token: string,
): Effect.Effect<Response, ModelTurnFailed> {
  return Effect.tryPromise({
    try: (signal) =>
      input.fetcher(RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body,
        redirect: "manual",
        signal,
      }),
    catch: modelUnavailable,
  });
}

function refusedTwice(
  credential: ChatGPTCredential,
  token: string,
): Effect.Effect<never, ModelTurnFailed> {
  logEvent("error", "chatgpt.model-call", { outcome: "refused", status: 401 });

  return Effect.promise(() =>
    credential.markRefused(token).catch(() => {
      /* the connection still says connected; the next call is refused and marks it again */
    }),
  ).pipe(Effect.andThen(Effect.fail(reconnectRequired())));
}

/** A provider response and the token that was sent for it. */
type Answer = Readonly<{ response: Response; token: string }>;

/**
 * Send the request, retrying once after a 401: with the newer token if another call already
 * replaced the refused one, otherwise after one refresh. A second 401 marks the connection as
 * needing a reconnect. Nothing is retried once the provider's stream has started.
 */
function answered(input: ChatGPTTurnInput, body: string): Effect.Effect<Answer, ChatGPTRefusal> {
  return Effect.gen(function* () {
    const first = yield* accessToken(input.credential);
    const response = yield* send(input, body, first);

    if (response.status !== 401) return { response, token: first };
    yield* Effect.promise(() => discardBody(response));
    logEvent("warn", "chatgpt.model-call", { outcome: "retrying", status: 401 });

    const second = yield* accessToken(input.credential, first);
    const retried = yield* send(input, body, second);

    if (retried.status !== 401) return { response: retried, token: second };
    yield* Effect.promise(() => discardBody(retried));

    return yield* refusedTwice(input.credential, second);
  });
}

/**
 * One model call on the owner's ChatGPT plan, translated into the route's events. The route
 * answers from Workers AI instead in two cases, both before anything was emitted: no credential is
 * connected ({@link ChatGPTNotConnected}), or the plan's usage limit refused the call
 * ({@link ChatGPTUsageLimited}).
 */
export function chatgptTurn(
  input: ChatGPTTurnInput,
  request: ModelRouteRequest,
): (emit: (event: ModelStreamEvent) => void) => Effect.Effect<ModelTurnAnswer, ChatGPTRefusal> {
  const body = JSON.stringify(responsesRequest(input.model, request));

  return (emit) =>
    Effect.gen(function* () {
      const { response, token } = yield* answered(input, body);

      if (!response.ok || response.body === null) {
        const error = yield* errorOf(response);

        return yield* refused(input.credential, token, "http-error", response, error, false);
      }

      let outputSent = false;

      const accumulator = new ProviderStreamAccumulator((event) => {
        outputSent = true;
        emit(event);
      });

      const reader = new ResponsesStreamReader(accumulator);

      // oxlint-disable-next-line typescript/no-unsafe-argument -- SAFETY: a fetch response body is a byte stream.
      yield* pumpSseStream(response.body, (line) => reader.handleLine(line));

      if (reader.failure !== undefined) {
        return yield* refused(
          input.credential,
          token,
          "stream-failed",
          response,
          reader.failure,
          outputSent,
        );
      }

      return finishedTurn(accumulator, request);
    });
}
