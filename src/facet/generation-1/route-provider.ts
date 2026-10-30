import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import type {
  Model,
  Provider,
  ProviderStreams,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ModelStreamEvent } from "../../model-route.js";
import type { ModelCapability } from "./capabilities.js";
import { transcriptToRouteRequest } from "./route-request.js";
import { ReplyAssembler } from "./route-reply.js";

/**
 * Pi sizes a response against these, so they are nonzero. Costs are zero because real prices are
 * unknown; `maxTokens` is the host route's own output cap.
 */
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
    reader.cancel().catch(() => {
      /* the stream already ended or failed; nothing more to release */
    });
  };

  signal?.addEventListener("abort", cancel, { once: true });
  let buffer = "";

  try {
    for (;;) {
      const next = await reader.read();

      if (signal?.aborted === true) {
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
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the host route writes exactly this union, one event per line.
        const event = JSON.parse(line) as ModelStreamEvent;
        reply.apply(event);

        if (event.type === "done" || event.type === "error") return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

/** The facet has no network: the host's model route behind the MODEL binding is this provider's only I/O. */
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
