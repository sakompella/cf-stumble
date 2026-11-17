import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import type {
  Model,
  Provider,
  ProviderStreams,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  MAX_OUTPUT_TOKENS,
  MAX_STREAM_EVENT_BYTES,
  REASONING_EFFORT,
  type ModelStreamEvent,
} from "../../model-route-wire/events.js";
import { ROUTE_FAILURE, type RouteFailure } from "../../model-route-wire/failure.js";
import type { ModelRouteRequest } from "../../model-route-wire/request.js";
import { errorFields, type FacetLog, type ModelCapability } from "../conversation-protocol.js";
import { LineReader } from "./line-reader.js";
import { isModelStreamEvent } from "./route-events.js";
import { transcriptToRouteRequest } from "./route-request.js";
import { ReplyAssembler } from "./route-reply.js";

export const ROUTE_MODEL: Model<"host-model-route"> = {
  id: "host-model-route",
  name: "Host model route",
  api: "host-model-route",
  provider: "host-model-route",
  baseUrl: "",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: MAX_OUTPUT_TOKENS,
};

const CANCELLED = "the turn was cancelled";

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function routeRequest(
  context: TranscriptContext,
  sessionId: string | undefined,
): ModelRouteRequest {
  const request = transcriptToRouteRequest(context);

  return sessionId === undefined ? request : { ...request, promptCacheKey: sessionId };
}

type Failed = (kind: RouteFailure, cause?: Error) => void;

function parseEvent(text: string): ModelStreamEvent | undefined {
  try {
    const event: unknown = JSON.parse(text);

    return isModelStreamEvent(event) ? event : undefined;
  } catch {
    return undefined;
  }
}

async function relay(
  reader: LineReader,
  signal: AbortSignal | undefined,
  reply: ReplyAssembler,
  failed: Failed,
): Promise<void> {
  for (;;) {
    const line = await reader.next();

    if (aborted(signal)) {
      reply.fail("aborted", CANCELLED);

      return;
    }

    if (line.kind === "eof" || line.kind === "truncated" || line.kind === "stream-error") {
      failed("streamInterrupted");

      return;
    }

    if (line.kind !== "line") {
      failed("unreadableReply");

      return;
    }

    if (line.text === "") continue;

    const event = parseEvent(line.text);

    if (event === undefined) {
      failed("unreadableReply");

      return;
    }

    reply.apply(event);

    if (event.type === "done" || event.type === "error") return;
  }
}

async function pump(
  capability: ModelCapability,
  context: TranscriptContext,
  options: StreamOptions | undefined,
  reply: ReplyAssembler,
  failed: Failed,
): Promise<void> {
  const signal = options?.signal;
  let route: Awaited<ReturnType<ModelCapability["runStream"]>>;

  try {
    route = await capability.runStream(routeRequest(context, options?.sessionId));
  } catch (cause) {
    if (aborted(signal)) reply.fail("aborted", CANCELLED);
    else failed("routeUnreachable", asError(cause));

    return;
  }

  if (!(route instanceof ReadableStream)) {
    reply.fail("error", route.error.reason);

    return;
  }

  const reader = new LineReader(route.getReader(), MAX_STREAM_EVENT_BYTES);

  const cancel = () => {
    reader.cancel();
  };

  signal?.addEventListener("abort", cancel, { once: true });

  try {
    if (aborted(signal)) reply.fail("aborted", CANCELLED);
    else await relay(reader, signal, reply, failed);
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

export const ROUTE_AGENT = {
  model: { provider: ROUTE_MODEL.provider, modelId: ROUTE_MODEL.id },
  thinkingLevel: REASONING_EFFORT,
} as const;

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function routeProvider(model: ModelCapability, log: FacetLog): Provider {
  const stream: ProviderStreams["stream"] = (routeModel, context, options?: StreamOptions) => {
    const out = createAssistantMessageEventStream();
    const reply = new ReplyAssembler(out, routeModel);

    const failed: Failed = (kind, cause) => {
      if (cause === undefined) log("error", "model-route-failed", { kind });
      else log("error", "model-route-failed", { kind, ...errorFields(cause) });
      reply.fail("error", ROUTE_FAILURE[kind]);
    };

    pump(model, context, options, reply, failed).catch((cause: unknown) => {
      if (options?.signal?.aborted === true) reply.fail("aborted", CANCELLED);
      else failed("unreadableReply", asError(cause));
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
