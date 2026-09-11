import { createAssistantMessageEventStream } from "@cf-stumble/pi";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Models,
  StreamFn,
} from "@cf-stumble/pi";

const NO_REGISTRY = "this generation reaches one fixed model route, not a provider registry";

const NO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function unavailable<T>(): Promise<T> {
  return Promise.reject(new Error(NO_REGISTRY));
}

/**
 * The one-event stream Pi's streaming contract requires of a call that cannot be made: a terminal
 * error rather than a throw, because `Models.stream` and `Models.streamSimple` return a stream and
 * a caller of either reads its result instead of catching.
 */
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
      usage: NO_USAGE,
      stopReason: "error",
      errorMessage: NO_REGISTRY,
      timestamp: Date.now(),
    },
  });

  return stream;
}

/**
 * Presents the host model route as the `Models` value Pi's compaction functions take.
 *
 * Pi's `compact` summarizes through `Models.completeSimple` and uses nothing else on this
 * interface. Generation 0 has no provider registry and no credential to build one from — the model,
 * the endpoint, and the key all live behind the immutable `src/model-route.ts` — so every member
 * that would select a provider, resolve authentication, log in, or fetch a deferred result reports
 * that instead of pretending to have one. The members that do mean "call the model" all mean the
 * same single call here, and go to the same route stream function the turn itself runs on. The
 * two provider-API members, `stream` and `complete`, carry options a specific provider's API
 * defines; one fixed route cannot honor those, so they report unavailable as well.
 *
 * This is the shape `createFacetExecutionEnv` already takes with Pi's `ExecutionEnv`: implement
 * what the capability supports and report the rest as unsupported, rather than inventing a second,
 * weaker version of the missing part.
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
