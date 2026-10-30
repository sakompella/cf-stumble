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

/** The token reaches this isolate and the provider, never a facet. */
export type ChatGPTCredential = Readonly<{
  access(rejected?: string): Promise<ChatGPTAccess>;
  markRefused(accessToken: string): Promise<void>;
  markUsageLimited(accessToken: string, limitedUntil: number | null): Promise<void>;
}>;

export class ChatGPTNotConnected extends Data.TaggedError("ChatGPTNotConnected") {}

/** Refused before any output reached the caller, so the route can still answer from Workers AI. */
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

/** Only a parsed body's error type and code reach the log. */
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

/** The rest of the body may echo the request. */
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
 * Logs only the HTTP status and the error type and code. The route must never splice a second
 * provider's answer onto a partial one, so only a limit that reached the caller with nothing fails.
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

/** A redirect is never followed because it could carry the token elsewhere. */
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

type Answer = Readonly<{ response: Response; token: string }>;

/** Retries once after a 401. Nothing is retried once the provider's stream has started. */
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
