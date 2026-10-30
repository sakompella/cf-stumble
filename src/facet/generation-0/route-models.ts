import { createAssistantMessageEventStream } from "@cf-stumble/pi";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Models,
  StreamFn,
} from "@cf-stumble/pi";
import { ZERO_USAGE } from "./stream-assembler.js";

const NO_REGISTRY = "this generation reaches one fixed model route, not a provider registry";

function unavailable<T>(): Promise<T> {
  return Promise.reject(new Error(NO_REGISTRY));
}

/** A terminal error event rather than a throw: callers of `stream` read its result instead of catching. */
function unavailableStream(model: Model<Api>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: "error",
      errorMessage: NO_REGISTRY,
      timestamp: Date.now(),
    },
  });

  return stream;
}

/**
 * Pi's `compact` uses only `completeSimple`. There is no provider registry or credential here, so members
 * that would select a provider or authenticate report unavailable, and so do `stream` and `complete`,
 * whose provider-specific options one fixed route cannot honor.
 */
export function createRouteModels(streamFn: StreamFn): Models {
  const call = async (...request: Parameters<StreamFn>): Promise<AssistantMessage> => {
    const stream = await streamFn(...request);

    return stream.result();
  };

  return {
    getProviders: () => [],
    // oxlint-disable-next-line unicorn/no-useless-undefined -- `Models` declares "no such provider" and "no such model" as `undefined`; there is nothing else to return.
    getProvider: () => undefined,
    getModels: () => [],
    // oxlint-disable-next-line unicorn/no-useless-undefined -- See above.
    getModel: () => undefined,
    refresh: () => unavailable(),
    checkAuth: () => unavailable(),
    getAvailable: () => unavailable(),
    getAuth: () => unavailable(),
    login: () => unavailable(),
    logout: () => unavailable(),
    stream: (model) => unavailableStream(model),
    complete: () => unavailable(),
    streamSimple: (model) => unavailableStream(model),
    completeSimple: (model, context, options) => call(model, context, options),
    fetchDeferred: () => unavailable(),
    cancelDeferred: () => unavailable(),
  };
}
