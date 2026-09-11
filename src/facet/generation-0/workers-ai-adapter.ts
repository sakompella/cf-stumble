import type {
  ModelRouteRequest,
  ModelRouteResponse,
  AssistantMessage as RouteAssistantMessage,
  ToolDefinition,
  RouteMessage,
} from "../../model-route.js";

// -- Narrow Pi shapes the adapter consumes ----------------------------------
//
// These mirror the vendored Pi types without importing the package, so the
// adapter stays pure and separately testable.

export type PiTextContent = Readonly<{ type: "text"; text: string }>;

export type PiThinkingContent = Readonly<{ type: "thinking"; thinking: string }>;

export type PiToolCall = Readonly<{
  type: "toolCall";
  id: string;
  name: string;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Boundary: Pi tool call arguments are an open object from the model; the vendored type is Record<string, any>.
  arguments: Record<string, unknown>;
}>;

export type PiContentBlock = PiTextContent | PiThinkingContent | PiToolCall;

export type PiUserMessage = Readonly<{
  role: "user";
  content: string | ReadonlyArray<PiTextContent>;
  timestamp: number;
}>;

export type PiAssistantMessage = Readonly<{
  role: "assistant";
  content: ReadonlyArray<PiContentBlock>;
  api: string;
  provider: string;
  model: string;
  usage: PiUsage;
  stopReason: string;
  timestamp: number;
}>;

export type PiToolResultMessage = Readonly<{
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ReadonlyArray<PiTextContent>;
  isError: boolean;
  timestamp: number;
}>;

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export type PiUsage = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: Readonly<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  }>;
}>;

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Boundary: Pi tool parameter schemas are open JSON Schema objects from the vendored package.
export type PiToolParameters = Readonly<Record<string, unknown>>;

export type PiTool = Readonly<{
  name: string;
  description: string;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Boundary: mirrors PiToolParameters above.
  parameters: PiToolParameters;
}>;

export type PiContext = Readonly<{
  systemPrompt?: string;
  messages: ReadonlyArray<PiMessage>;
  tools?: ReadonlyArray<PiTool>;
}>;

// -- Conversion errors ------------------------------------------------------

export type AdapterError = Readonly<{
  code: "unknown-role" | "model-unavailable";
  detail: string;
}>;

export function isAdapterError(value: ModelRouteRequest | AdapterError): value is AdapterError {
  return "code" in value;
}

export function isResponseError(value: PiAssistantMessage | AdapterError): value is AdapterError {
  return "code" in value;
}

// -- Pi Context -> ModelRouteRequest ----------------------------------------

function userContentToString(content: PiUserMessage["content"]): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: Pi UserMessage.content is a union of string and array; typeof is the narrowing required by the union.
  if (typeof content === "string") return content;

  return content.map((block) => block.text).join("");
}

function piToolCallToRoute(tc: PiToolCall): RouteAssistantMessage["tool_calls"][number] {
  return {
    id: tc.id,
    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
  };
}

function piAssistantToRoute(msg: PiAssistantMessage): RouteAssistantMessage {
  const texts: string[] = [];
  const toolCalls: RouteAssistantMessage["tool_calls"][number][] = [];

  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        break;
      case "toolCall":
        toolCalls.push(piToolCallToRoute(block));
        break;
      case "thinking":
        // Thinking blocks are not sent to the route.
        break;
    }
  }

  const content = texts.length > 0 ? texts.join("") : null;

  return { role: "assistant", content, tool_calls: toolCalls };
}

function piMessageToRoute(msg: PiMessage): RouteMessage {
  switch (msg.role) {
    case "user":
      return { role: "user", content: userContentToString(msg.content) };
    case "assistant":
      return piAssistantToRoute(msg);
    case "toolResult":
      return {
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content.map((b) => b.text).join(""),
      };
    default: {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Exhaustiveness guard: underscore signals the value is never reached.
      const _exhaustive: never = msg;

      return _exhaustive;
    }
  }
}

function piToolToRoute(tool: PiTool): ToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      // SAFETY: PiToolParameters is Readonly<Record<string, unknown>>, assignable to object.
      parameters: tool.parameters,
    },
  };
}

/**
 * Convert a Pi-shaped context into a {@link ModelRouteRequest}.
 *
 * Never selects a model, sets reasoning effort, or accesses credentials.
 */
export function piContextToRouteRequest(context: PiContext): ModelRouteRequest {
  const messages: RouteMessage[] = [];

  if (context.systemPrompt !== undefined && context.systemPrompt !== "") {
    messages.push({ role: "system", content: context.systemPrompt });
  }

  for (const msg of context.messages) {
    messages.push(piMessageToRoute(msg));
  }

  if (context.tools !== undefined && context.tools.length > 0) {
    return { messages, tools: context.tools.map(piToolToRoute) };
  }

  return { messages };
}

// -- ModelRouteResponse -> Pi AssistantMessage -------------------------------

const ZERO_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function routeToolCallToPi(tc: RouteAssistantMessage["tool_calls"][number]): PiToolCall {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Boundary: JSON.parse of tool arguments returns an unvalidated object from the model route.
  let parsed: Record<string, unknown>;

  try {
    const raw: unknown = JSON.parse(tc.function.arguments);

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: parsed JSON from the model route needs typeof to confirm object before use.
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: typeof + null + array guard confirmed a plain object; Record<string, unknown> is the correct representation for parsed JSON tool arguments.
      parsed = raw as Record<string, unknown>;
    } else {
      parsed = {};
    }
  } catch {
    parsed = {};
  }

  return { type: "toolCall", id: tc.id, name: tc.function.name, arguments: parsed };
}

/**
 * Convert a successful {@link ModelRouteResponse} into a Pi-shaped assistant
 * message.
 *
 * Returns an {@link AdapterError} when the route reports a model failure.
 * Never selects a model, sets reasoning effort, or accesses credentials.
 */
export function routeResponseToPiAssistant(
  response: ModelRouteResponse,
): PiAssistantMessage | AdapterError {
  if (!response.ok) {
    return { code: "model-unavailable", detail: response.error.code };
  }

  const content: PiContentBlock[] = [];

  if (response.message.content !== null) {
    content.push({ type: "text", text: response.message.content });
  }

  for (const tc of response.message.tool_calls) {
    content.push(routeToolCallToPi(tc));
  }

  return {
    role: "assistant",
    content,
    api: "workers-ai",
    provider: "cloudflare-workers-ai",
    model: "adapter-passthrough",
    usage: ZERO_USAGE,
    stopReason: response.message.tool_calls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}
