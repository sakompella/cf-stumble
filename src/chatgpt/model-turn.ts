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
  providerErrorOfText,
  RESPONSES_ENDPOINT,
  ResponsesStreamReader,
  responsesRequest,
  retryAt,
  UNKNOWN_PROVIDER_ERROR,
  type ProviderError,
} from "./responses.js";

export type ChatGPTCredential = Readonly<{
  access(rejected?: string): Promise<ChatGPTAccess>;
  markRefused(accessToken: string): Promise<void>;
  markUsageLimited(accessToken: string, limitedUntil: number | null): Promise<void>;
}>;

class ChatGPTNotConnected extends Data.TaggedError("ChatGPTNotConnected") {}

class ChatGPTUsageLimited extends Data.TaggedError("ChatGPTUsageLimited")<{
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

function errorOf(response: Response): Effect.Effect<ProviderError> {
  return Effect.promise(async () => {
    try {
      const text = await response.text();

      return text.length > MAX_ERROR_BODY_BYTES
        ? UNKNOWN_PROVIDER_ERROR
        : providerErrorOfText(text);
    } catch {
      return UNKNOWN_PROVIDER_ERROR;
    }
  });
}

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
    credential.markUsageLimited(token, limitedUntil).catch(() => {}),
  ).pipe(
    Effect.andThen(
      Effect.fail(outputSent ? modelUnavailable() : new ChatGPTUsageLimited({ limitedUntil })),
    ),
  );
}

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

  return Effect.promise(() => credential.markRefused(token).catch(() => {})).pipe(
    Effect.andThen(Effect.fail(reconnectRequired())),
  );
}

type Answer = Readonly<{ response: Response; token: string }>;

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
