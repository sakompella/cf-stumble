import type { AssistantMessage, ModelRouteRequest } from "./model-route.js";
import type { ModelUsage } from "./model-route-events.js";

const USAGE_BYTES = new TextEncoder();

const ESTIMATED_BYTES_PER_TOKEN = 3;

function estimateTokens(byteLength: number): number {
  return Math.ceil(byteLength / ESTIMATED_BYTES_PER_TOKEN);
}

export function resolveUsage(
  reported: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
  request: ModelRouteRequest,
  message: AssistantMessage,
): ModelUsage {
  if (reported !== undefined) {
    return {
      inputTokens: reported.inputTokens,
      outputTokens: reported.outputTokens,
      estimated: false,
    };
  }

  const promptBytes = USAGE_BYTES.encode(JSON.stringify(request.messages)).length;

  const completionBytes = USAGE_BYTES.encode(
    (message.content ?? "") + JSON.stringify(message.tool_calls),
  ).length;

  return {
    inputTokens: estimateTokens(promptBytes),
    outputTokens: estimateTokens(completionBytes),
    estimated: true,
  };
}
