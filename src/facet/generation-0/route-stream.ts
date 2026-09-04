import { createAssistantMessageEventStream } from "@cf-stumble/pi";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  StreamFn,
} from "@cf-stumble/pi";

/**
 * `@cf-stumble/pi` exports `StreamFn` but not the `Context` it receives, so derive both that and
 * its message type from the function it belongs to rather than restating either shape here.
 */
type Context = Parameters<StreamFn>[1];
type Message = Context["messages"][number];
import {
  isResponseError,
  piContextToRouteRequest,
  routeResponseToPiAssistant,
} from "./workers-ai-adapter.js";
import type { PiMessage, PiTool, PiToolParameters } from "./workers-ai-adapter.js";
import type { ModelCapability } from "./capabilities.js";

/**
 * The model descriptor Pi's `Agent` needs in its state. Every field the host actually decides —
 * which model, which reasoning effort, which endpoint, which credential — lives behind the model
 * route in the immutable `src/model-route.ts`, so nothing here selects anything. This describes
 * the route, not a model, which is why its costs and its context window are zero: Generation 0 has
 * no way to learn the real values and must not invent them.
 */
export const ROUTE_MODEL = {
  id: "host-model-route",
  name: "Host model route",
  api: "workers-ai",
  provider: "cloudflare-workers-ai",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
} satisfies Model<Api>;

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

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

function assistantShell(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: ROUTE_MODEL.api,
    provider: ROUTE_MODEL.provider,
    model: ROUTE_MODEL.id,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
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

function failedStream(detail: string): AssistantMessageEventStream {
  return endedStream("error", detail);
}

async function streamOnce(
  model: ModelCapability,
  context: Context,
): Promise<AssistantMessageEventStream> {
  const messages = routableMessages(context.messages);
  if (messages === undefined) return failedStream("the conversation holds non-text content");

  const request = piContextToRouteRequest(
    context.systemPrompt === undefined
      ? { messages, tools: routableTools(context.tools) }
      : {
          systemPrompt: context.systemPrompt,
          messages,
          tools: routableTools(context.tools),
        },
  );

  let response;
  try {
    response = await model.run(request);
  } catch {
    return failedStream("the model route did not answer");
  }
  if (!response.ok) return failedStream(response.error.code);

  const assistant = routeResponseToPiAssistant(response);
  if (isResponseError(assistant)) return failedStream(assistant.detail);

  const message: AssistantMessage = {
    ...assistantShell(assistant.stopReason === "toolUse" ? "toolUse" : "stop"),
    content: [...assistant.content],
    timestamp: assistant.timestamp,
  };
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "done",
    reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
    message,
  });
  return stream;
}

/**
 * Drives Pi's `Agent` from the host model route. The route answers one buffered assistant message
 * per call, so each stream this returns carries exactly one terminal event; nothing here fakes
 * token-by-token deltas the route never produced.
 *
 * Every failure — a route that rejects, reports a model problem, or answers with content this
 * generation cannot represent — becomes an `error` event. Pi records that on the agent's state,
 * which is what turns it into one reported turn problem rather than a thrown turn.
 *
 * An aborted `signal` stops the route being called at all. Pi's own abort unwinds the agent loop
 * at its own checkpoints, which still leaves room for one more model call after a caller has
 * walked away; refusing here is what makes a cancelled turn stop spending.
 */
export function createRouteStreamFn(model: ModelCapability, signal?: AbortSignal): StreamFn {
  return (_model, context) =>
    signal?.aborted === true
      ? endedStream("aborted", "the turn was cancelled")
      : streamOnce(model, context);
}
