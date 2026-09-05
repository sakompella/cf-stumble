import { createAssistantMessageEventStream } from "@cf-stumble/pi";
import type { AgentMessage, Api, AssistantMessage, Model, StreamFn } from "@cf-stumble/pi";

/**
 * A deterministic stand-in for the host model route. Every test that drives a Pi agent turn needs
 * assistant messages it chose itself, so these helpers script them directly rather than reaching a
 * model.
 */
export const scriptedModel = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
} satisfies Model<Api>;

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

export function assistant(
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: scriptedModel.api,
    provider: scriptedModel.provider,
    model: scriptedModel.id,
    usage,
    stopReason,
    timestamp: 0,
  };
}

type ScriptedContext = Readonly<{
  systemPrompt?: string | undefined;
  messages: readonly AgentMessage[];
}>;

export function scriptedStream(messages: readonly AssistantMessage[]) {
  const remaining = [...messages];
  const contexts: ScriptedContext[] = [];
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(context);
    const message = remaining.shift() ?? assistant([], "stop");
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    return stream;
  };
  return { contexts, streamFn };
}

/**
 * A route that answers one reply as a sequence of text deltas, the way a provider that streams
 * tokens does. `scriptedStream` answers each call with one finished message, so it cannot show
 * whether a reply reaches the browser incrementally; this can.
 */
export function deltaStream(chunks: readonly string[]) {
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    let text = "";
    const partial = (): AssistantMessage => assistant([{ type: "text", text }], "stop");
    stream.push({ type: "start", partial: partial() });
    stream.push({ type: "text_start", contentIndex: 0, partial: partial() });
    for (const chunk of chunks) {
      text += chunk;
      stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: partial() });
    }
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: partial() });
    stream.push({ type: "done", reason: "stop", message: partial() });
    return stream;
  };
  return { streamFn };
}

export function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
