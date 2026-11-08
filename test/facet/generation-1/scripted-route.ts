import { createModels } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import type { ModelCapability } from "../../../src/facet/generation-1/capabilities.js";
import { ROUTE_MODEL, routeProvider } from "../../../src/facet/generation-1/route-provider.js";
import type {
  ModelRouteRequest,
  ValidationFailure,
} from "../../../src/model-route-wire/request.js";
import type { ModelStreamEvent } from "../../../src/model-route-wire/events.js";

const encoder = new TextEncoder();

export const NO_USAGE = { inputTokens: 0, outputTokens: 0, estimated: false };

export const GO: Context = { messages: [{ role: "user", content: "go", timestamp: 0 }] };

function ndjson(events: readonly ModelStreamEvent[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      controller.close();
    },
  });
}

export function pushableStream() {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  return {
    readable,
    push: (event: ModelStreamEvent) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`)),
  };
}

export type Answer = () => Promise<ReadableStream<Uint8Array> | ValidationFailure>;

export function scriptedRoute(...answers: readonly Answer[]) {
  const requests: ModelRouteRequest[] = [];
  const queue = [...answers];

  const capability: ModelCapability = {
    runStream(request) {
      requests.push(request);
      const answer = queue.shift();

      return answer === undefined ? Promise.reject(new Error("no scripted answer")) : answer();
    },
  };

  return { requests, capability };
}

export const replies =
  (events: readonly ModelStreamEvent[]): Answer =>
  () =>
    Promise.resolve(ndjson(events));

export function streamThroughProvider(
  capability: ModelCapability,
  context: Context,
  signal?: AbortSignal,
) {
  const models = createModels();
  models.setProvider(routeProvider(capability));

  return models.stream(ROUTE_MODEL, context, signal === undefined ? {} : { signal });
}
