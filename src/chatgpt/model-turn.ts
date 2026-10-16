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
import { isRecord } from "../untrusted.js";
import type { ChatGPTAccess } from "./connection-view.js";
import { discardBody, type ProviderFetch } from "./oauth.js";
import {
  RESPONSES_ENDPOINT,
  ResponsesStreamReader,
  responsesRequest,
  safeCode,
} from "./responses.js";

/**
 * What the model route needs from the Supervisor that holds the owner's credential: the token to
 * send now, and a way to report one the provider refused after a refresh. Both are Supervisor RPC
 * calls; the token reaches this isolate and the provider, never a facet.
 */
export type ChatGPTCredential = Readonly<{
  access(rejected?: string): Promise<ChatGPTAccess>;
  markRefused(accessToken: string): Promise<void>;
}>;

/** No ChatGPT credential is connected, so the route answers from Workers AI instead. */
export class ChatGPTNotConnected extends Data.TaggedError("ChatGPTNotConnected") {}

export type ChatGPTTurnInput = Readonly<{
  credential: ChatGPTCredential;
  fetcher: ProviderFetch;
  model: string;
}>;

const reconnectRequired = (): ModelTurnFailed =>
  new ModelTurnFailed({ code: "chatgpt-reconnect-required" });

/** A longer error body is not parsed, and only a parsed body's `error.code` reaches the log. */
const MAX_ERROR_BODY_BYTES = 4096;

function accessToken(
  credential: ChatGPTCredential,
  rejected?: string,
): Effect.Effect<string, ModelTurnFailed | ChatGPTNotConnected> {
  return Effect.tryPromise({
    try: () => credential.access(rejected),
    catch: modelUnavailable,
  }).pipe(
    Effect.flatMap((access): Effect.Effect<string, ModelTurnFailed | ChatGPTNotConnected> => {
      switch (access.kind) {
        case "ready":
          return Effect.succeed(access.accessToken);
        case "not-connected":
          return Effect.fail(new ChatGPTNotConnected());
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

/** The provider's `error.code`, for the log. The rest of the body may echo the request. */
function errorCode(response: Response): Effect.Effect<string> {
  return Effect.promise(async () => {
    try {
      const text = await response.text();
      const body: unknown = text.length > MAX_ERROR_BODY_BYTES ? undefined : JSON.parse(text);
      const error = isRecord(body) ? body.error : undefined;

      return safeCode(isRecord(error) ? error.code : undefined);
    } catch {
      return "unknown";
    }
  });
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

/**
 * Send the request, retrying once after a 401: with the newer token if another call already
 * replaced the refused one, otherwise after one refresh. A second 401 marks the connection as
 * needing a reconnect. Nothing is retried once the provider's stream has started.
 */
function answered(
  input: ChatGPTTurnInput,
  body: string,
): Effect.Effect<Response, ModelTurnFailed | ChatGPTNotConnected> {
  return Effect.gen(function* () {
    const first = yield* accessToken(input.credential);
    const response = yield* send(input, body, first);

    if (response.status !== 401) return response;
    yield* Effect.promise(() => discardBody(response));
    logEvent("warn", "chatgpt.model-call", { outcome: "retrying", status: 401 });

    const second = yield* accessToken(input.credential, first);
    const retried = yield* send(input, body, second);

    if (retried.status !== 401) return retried;
    yield* Effect.promise(() => discardBody(retried));

    return yield* refusedTwice(input.credential, second);
  });
}

/**
 * One model call on the owner's ChatGPT plan, translated into the route's events. It fails with
 * {@link ChatGPTNotConnected} before sending anything when no credential is connected, which is the
 * one case the route answers from Workers AI instead.
 */
export function chatgptTurn(
  input: ChatGPTTurnInput,
  request: ModelRouteRequest,
): (
  emit: (event: ModelStreamEvent) => void,
) => Effect.Effect<ModelTurnAnswer, ModelTurnFailed | ChatGPTNotConnected> {
  const body = JSON.stringify(responsesRequest(input.model, request));

  return (emit) =>
    Effect.gen(function* () {
      const response = yield* answered(input, body);

      if (!response.ok || response.body === null) {
        const code = yield* errorCode(response);
        logEvent("error", "chatgpt.model-call", {
          outcome: "http-error",
          status: response.status,
          code,
        });

        return yield* modelUnavailable();
      }

      const accumulator = new ProviderStreamAccumulator(emit);
      const reader = new ResponsesStreamReader(accumulator);

      // oxlint-disable-next-line typescript/no-unsafe-argument -- SAFETY: a fetch response body is a byte stream.
      yield* pumpSseStream(response.body, (line) => reader.handleLine(line));

      if (reader.failure !== undefined) {
        logEvent("error", "chatgpt.model-call", { outcome: "stream-failed", code: reader.failure });

        return yield* modelUnavailable();
      }

      return finishedTurn(accumulator, request);
    });
}
