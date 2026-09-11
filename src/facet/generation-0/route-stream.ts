import { createAssistantMessageEventStream } from "@cf-stumble/pi";
import type { AssistantMessageEventStream, StreamFn } from "@cf-stumble/pi";

/**
 * `@cf-stumble/pi` exports `StreamFn` but not the `Context` it receives, so derive both that and
 * its message type from the function it belongs to rather than restating either shape here.
 */
type Context = Parameters<StreamFn>[1];

type Message = Context["messages"][number];

import { assistantShell, TurnAssembler } from "./stream-assembler.js";
import {
  isResponseError,
  piContextToRouteRequest,
  routeResponseToPiAssistant,
} from "./workers-ai-adapter.js";
import type { PiMessage, PiTool, PiToolParameters } from "./workers-ai-adapter.js";
import type { ModelCapability } from "./capabilities.js";
import type { ModelStreamEvent, ValidationFailure } from "../../model-route.js";
import { toPiUsage } from "./stream-assembler.js";

export { ROUTE_MODEL } from "./stream-assembler.js";

/**
 * Narrows one Pi message to the text-only shape the model route's closed message union can carry,
 * or reports `undefined` when it holds content the route has no field for.
 *
 * Generation 0 prompts with text and runs four text tools, so image content cannot arise from its
 * own turns. Rejecting it is still the honest answer for a conversation that somehow holds one:
 * the route would otherwise receive a message with the image silently missing, and the model would
 * answer about a picture it never saw.
 */
function routableMessage(message: Message): PiMessage | undefined {
  if (message.role === "assistant") return message;

  if (message.role === "user") {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Pi types this content as `string | (TextContent | ImageContent)[]`; the union needs narrowing.
    if (typeof message.content === "string") return { ...message, content: message.content };
    const text = message.content.filter((block) => block.type === "text");

    return text.length === message.content.length ? { ...message, content: text } : undefined;
  }

  const text = message.content.filter((block) => block.type === "text");

  return text.length === message.content.length ? { ...message, content: text } : undefined;
}

function routableMessages(messages: readonly Message[]): readonly PiMessage[] | undefined {
  const routable: PiMessage[] = [];

  for (const message of messages) {
    const narrowed = routableMessage(message);

    if (narrowed === undefined) return undefined;
    routable.push(narrowed);
  }

  return routable;
}

function routableTools(tools: Context["tools"]): readonly PiTool[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: a Pi tool's typebox schema is a JSON Schema object, which is what the route's tool definition carries.
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

/**
 * Read one line of NDJSON the model route emits and narrow it to {@link ModelStreamEvent}. This
 * hop is internal (both ends live in this generation's own code, one Worker RPC apart), so this is
 * a shape check against a closed union rather than the untrusted-provider parsing `model-route.ts`
 * already did; an unrecognized `type` still degrades to a terminal error instead of throwing.
 */
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

  if (type === "text-delta" || type === "tool-call-delta" || type === "done" || type === "error") {
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
      const assistant = routeResponseToPiAssistant({ ok: true, message: event.message });

      if (isResponseError(assistant)) {
        assembler.fail(stream, "error", assistant.detail);

        return;
      }

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
    default: {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Exhaustiveness guard: underscore signals the value is never reached.
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }
}

/**
 * Read one decoded NDJSON line at a time from the model route's stream, translate each into
 * `assembler`'s Pi events, and stop at the first `done`/`error` event or when `signal` aborts.
 */
async function pumpModelStream(
  modelStream: ReadableStream<Uint8Array>,
  assembler: TurnAssembler,
  stream: AssistantMessageEventStream,
  signal: AbortSignal | undefined,
): Promise<void> {
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

        return;
      }

      const next = await reader.read();

      if (next.done) {
        if (isAborted(signal)) {
          assembler.fail(stream, "aborted", "the turn was cancelled");

          return;
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

        if (event.type === "done" || event.type === "error") return;
      }
    }

    // The provider stream closed without a terminal event: nothing more will arrive.
    assembler.fail(stream, "error", "the model route ended its stream without a result");
  } catch {
    assembler.fail(stream, "error", "the model route did not answer");
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
  let outcome: ReadableStream<Uint8Array> | ValidationFailure;

  try {
    outcome = await model.runStream(request);
  } catch {
    assembler.fail(stream, "error", "the model route did not answer");

    return;
  }

  if (!(outcome instanceof ReadableStream)) {
    assembler.fail(stream, "error", outcome.error.reason);

    return;
  }

  await pumpModelStream(outcome, assembler, stream, signal);
}

function streamOnce(
  model: ModelCapability,
  context: Context,
  signal: AbortSignal | undefined,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const messages = routableMessages(context.messages);

  if (messages === undefined) {
    stream.push({
      type: "error",
      reason: "error",
      error: {
        ...assistantShell("error"),
        errorMessage: "the conversation holds non-text content",
      },
    });

    return stream;
  }

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
 * Drives Pi's `Agent` from the host model route. `model.runStream` answers with incremental
 * events as the provider produces them (E5, E7); this pushes each into Pi's own
 * `AssistantMessageEvent` protocol as it arrives instead of buffering the whole reply first.
 *
 * Every failure — a route that rejects, reports a model problem, or answers with content this
 * generation cannot represent — becomes an `error` event. Pi records that on the agent's state,
 * which is what turns it into one reported turn problem rather than a thrown turn.
 *
 * An aborted `signal` stops the route being called at all when the abort happens before the model
 * call starts, and stops this route from reading any further chunks when the abort happens
 * mid-stream: the reader is cancelled and no further model calls are made. It does not prove the
 * provider itself stops producing tokens for an already-issued inference — Workers AI's binding
 * exposes no cancellation signal for a call already in flight — so cancellation here bounds what
 * this route spends afterward, not what the provider does upstream.
 */
export function createRouteStreamFn(model: ModelCapability, signal?: AbortSignal): StreamFn {
  return (_model, context) =>
    signal?.aborted === true
      ? endedStream("aborted", "the turn was cancelled")
      : streamOnce(model, context, signal);
}
