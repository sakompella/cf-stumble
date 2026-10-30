import { createAssistantMessageEventStream } from "@cf-stumble/pi";
import type { AssistantMessageEventStream, StreamFn } from "@cf-stumble/pi";

/** `@cf-stumble/pi` does not export `Context`, so it is derived from `StreamFn`. */
type Context = Parameters<StreamFn>[1];

type Message = Context["messages"][number];

import { assistantShell, TurnAssembler } from "./stream-assembler.js";
import { piContextToRouteRequest, routeMessageToPiAssistant } from "./workers-ai-adapter.js";
import type { PiMessage, PiTextContent, PiTool, PiToolParameters } from "./workers-ai-adapter.js";
import type { ModelCapability } from "./capabilities.js";
import type { ModelStreamEvent, ValidationFailure } from "../../model-route.js";
import { toPiUsage } from "./stream-assembler.js";

export { ROUTE_MODEL } from "./stream-assembler.js";

type ContentBlock = Extract<Message, { role: "toolResult" }>["content"][number];

/**
 * An older saved thread can hold an image the read tool now declines, and rejecting it would fail every
 * later turn on that thread.
 */
function textBlock(block: ContentBlock): PiTextContent {
  return block.type === "text"
    ? block
    : {
        type: "text",
        text: `[Image omitted (${block.mimeType}): this model route carries text only.]`,
      };
}

function routableMessage(message: Message): PiMessage {
  if (message.role === "assistant") return message;

  if (message.role === "user") {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Pi types this content as `string | (TextContent | ImageContent)[]`; the union needs narrowing.
    if (typeof message.content === "string") return { ...message, content: message.content };

    return { ...message, content: message.content.map((block) => textBlock(block)) };
  }

  return { ...message, content: message.content.map((block) => textBlock(block)) };
}

function routableTools(tools: Context["tools"]): readonly PiTool[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: a Pi tool's typebox schema is a JSON Schema object, which is what the route's tool definition carries.
    parameters: tool.parameters as PiToolParameters,
  }));
}

function endedStream(reason: "error" | "aborted", detail: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "error",
    reason,
    error: { ...assistantShell(reason), errorMessage: detail },
  });

  return stream;
}

/** Indirection so TypeScript does not (wrongly) assume `signal.aborted` cannot flip true across
 * an `await` just because nothing in this function's own body reassigns it. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Both ends are this generation's own code, so this checks a closed union; an unrecognized `type` degrades to a terminal error. */
function parseStreamEventLine(line: string): ModelStreamEvent | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: one decoded NDJSON line from the model route's own stream.
  if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) return undefined;
  const { type } = parsed;

  if (
    type === "text-delta" ||
    type === "tool-call-delta" ||
    type === "done" ||
    type === "error" ||
    type === "provider-fallback"
  ) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: `type` narrowed to every member of the closed ModelStreamEvent union above.
    return parsed as ModelStreamEvent;
  }

  return undefined;
}

function applyModelStreamEvent(
  event: ModelStreamEvent,
  assembler: TurnAssembler,
  stream: AssistantMessageEventStream,
): void {
  switch (event.type) {
    case "text-delta":
      assembler.textDelta(event.delta, stream);

      return;
    case "tool-call-delta":
      assembler.toolCallDelta(event.delta, stream);

      return;
    case "done": {
      const assistant = routeMessageToPiAssistant(event.message);

      assembler.finish(stream, {
        ...assistantShell(
          assistant.stopReason === "toolUse" ? "toolUse" : "stop",
          [...assistant.content],
          toPiUsage(event.usage),
        ),
        timestamp: assistant.timestamp,
      });

      return;
    }

    case "error":
      assembler.fail(stream, "error", event.error.code);

      return;
    case "provider-fallback":
      assembler.providerFallback(event);

      return;
    default: {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Exhaustiveness guard: underscore signals the value is never reached.
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }
}

async function pumpModelStream(
  modelStream: ReadableStream<Uint8Array>,
  assembler: TurnAssembler,
  stream: AssistantMessageEventStream,
  signal: AbortSignal | undefined,
): Promise<"completed" | "failed" | "aborted"> {
  const reader = modelStream.getReader();

  const abort = () => {
    reader.cancel().catch(() => {
      /* the stream already ended or failed; nothing more to release */
    });
  };

  signal?.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      if (isAborted(signal)) {
        assembler.fail(stream, "aborted", "the turn was cancelled");

        return "aborted";
      }

      const next = await reader.read();

      if (next.done) {
        if (isAborted(signal)) {
          assembler.fail(stream, "aborted", "the turn was cancelled");

          return "aborted";
        }

        break;
      }

      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") continue;
        const event = parseStreamEventLine(line);

        if (event === undefined) continue;
        applyModelStreamEvent(event, assembler, stream);

        if (event.type === "done") return "completed";

        if (event.type === "error") return "failed";
      }
    }

    assembler.fail(stream, "error", "the model route ended its stream without a result");

    return "failed";
  } catch {
    assembler.fail(stream, "error", "the model route did not answer");

    return "failed";
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function driveModelStream(
  model: ModelCapability,
  request: Parameters<ModelCapability["runStream"]>[0],
  assembler: TurnAssembler,
  stream: AssistantMessageEventStream,
  signal: AbortSignal | undefined,
): Promise<void> {
  let route: ReadableStream<Uint8Array> | ValidationFailure;

  try {
    route = await model.runStream(request);
  } catch {
    assembler.fail(stream, "error", "the model route did not answer");

    return;
  }

  if (!(route instanceof ReadableStream)) {
    assembler.fail(stream, "error", route.error.reason);

    return;
  }

  await pumpModelStream(route, assembler, stream, signal);
}

function streamOnce(
  model: ModelCapability,
  context: Context,
  signal: AbortSignal | undefined,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const messages = context.messages.map((message) => routableMessage(message));

  const request = piContextToRouteRequest(
    context.systemPrompt === undefined
      ? { messages, tools: routableTools(context.tools) }
      : { systemPrompt: context.systemPrompt, messages, tools: routableTools(context.tools) },
  );

  const assembler = new TurnAssembler();
  void driveModelStream(model, request, assembler, stream, signal);

  return stream;
}

/**
 * Every failure becomes an `error` event, which Pi records as one reported turn problem. Abort bounds
 * what this route spends afterward; Workers AI's binding has no cancellation for a call in flight.
 */
export function createRouteStreamFn(model: ModelCapability, signal?: AbortSignal): StreamFn {
  return (_model, context) =>
    signal?.aborted === true
      ? endedStream("aborted", "the turn was cancelled")
      : streamOnce(model, context, signal);
}
