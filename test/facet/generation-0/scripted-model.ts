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

export function scriptedStream(messages: readonly AssistantMessage[]) {
  const remaining = [...messages];
  const contexts: Array<Readonly<{ messages: readonly AgentMessage[] }>> = [];
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

export function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
