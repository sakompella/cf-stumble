import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import type {
  Model,
  Provider,
  ProviderStreams,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { isModelStreamEvent } from "../../model-route-events.js";
import type { ModelCapability } from "./capabilities.js";
import { transcriptToRouteRequest } from "./route-request.js";
import { ReplyAssembler } from "./route-reply.js";

export const ROUTE_MODEL: Model<"host-model-route"> = {
  id: "host-model-route",
  name: "Host model route",
  api: "host-model-route",
  provider: "host-model-route",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

const CANCELLED = "the turn was cancelled";

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function pump(
  capability: ModelCapability,
  context: TranscriptContext,
  signal: AbortSignal | undefined,
  reply: ReplyAssembler,
): Promise<void> {
  const route = await capability.runStream(transcriptToRouteRequest(context));

  if (!(route instanceof ReadableStream)) {
    reply.fail("error", route.error.reason);

    return;
  }

  const reader = route.pipeThrough(new TextDecoderStream()).getReader();

  const cancel = () => {
    reader.cancel().catch(() => {});
  };

  signal?.addEventListener("abort", cancel, { once: true });
  let buffer = "";

  try {
    if (aborted(signal)) {
      reply.fail("aborted", CANCELLED);

      return;
    }

    for (;;) {
      const next = await reader.read();

      if (aborted(signal)) {
        reply.fail("aborted", CANCELLED);

        return;
      }

      if (next.done) {
        reply.fail("error", "the model route ended its stream without a result");

        return;
      }

      const lines = (buffer + next.value).split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines.filter((candidate) => candidate !== "")) {
        const event: unknown = JSON.parse(line);

        if (!isModelStreamEvent(event)) throw new Error("the model route wrote an unknown event");
        reply.apply(event);

        if (event.type === "done" || event.type === "error") return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

export function routeProvider(model: ModelCapability): Provider {
  const stream: ProviderStreams["stream"] = (routeModel, context, options?: StreamOptions) => {
    const out = createAssistantMessageEventStream();
    const reply = new ReplyAssembler(out, routeModel);
    const signal = options?.signal;

    pump(model, context, signal, reply).catch(() => {
      reply.fail(signal?.aborted === true ? "aborted" : "error", "the model route did not answer");
    });

    return out;
  };

  return createProvider({
    id: ROUTE_MODEL.provider,
    auth: { apiKey: { name: ROUTE_MODEL.name, resolve: () => Promise.resolve({ auth: {} }) } },
    models: [ROUTE_MODEL],
    api: { stream, streamSimple: stream },
  });
}
