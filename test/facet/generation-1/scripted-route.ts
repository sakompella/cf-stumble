import { createModels } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import type { FacetLog, ModelCapability } from "../../../src/facet/conversation-protocol.js";
import { workersAiTurn } from "../../../src/model-route-stream.js";
import { modelEventStream } from "../../../src/model-route-turn.js";
import { providerStreamOfLines, sseLine, DONE_LINE } from "../../model-route-provider-stream.js";
import { ROUTE_MODEL, routeProvider } from "../../../src/facet/generation-1/route-provider.js";
import type {
  ModelRouteRequest,
  ValidationFailure,
} from "../../../src/model-route-wire/request.js";
import type { ModelStreamEvent } from "../../../src/model-route-wire/events.js";

const encoder = new TextEncoder();

export const NO_USAGE = { inputTokens: 0, outputTokens: 0, estimated: false };

export const NO_LOG: FacetLog = () => {};

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
  log: FacetLog = NO_LOG,
) {
  const models = createModels();
  models.setProvider(routeProvider(capability, log));

  return models.stream(ROUTE_MODEL, context, signal === undefined ? {} : { signal });
}

export function capacityOnceModel(calls: number[]): ModelCapability {
  return {
    runStream: (request) => {
      calls.push(Date.now());

      const ai = {
        run: () =>
          calls.length === 1
            ? Promise.reject(new Error("3040: Capacity temporarily exceeded, please try again."))
            : Promise.resolve(providerStreamOfLines([sseLine({ response: "hi" }), DONE_LINE])),
      };

      return Promise.resolve(modelEventStream(workersAiTurn(ai, request)));
    },
  };
}
