import type { ModelRouteRequest, ToolCall } from "./model-route.js";
import type { ModelUsage } from "./model-route-events.js";

export type ProviderResult = Readonly<{
  response?: string | null;
  tool_calls?: ReadonlyArray<ToolCall>;
}>;

const USAGE_BYTES = new TextEncoder();

const ESTIMATED_BYTES_PER_TOKEN = 3;

function estimateTokens(byteLength: number): number {
  return Math.ceil(byteLength / ESTIMATED_BYTES_PER_TOKEN);
}

export function resolveUsage(
  reported: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
  request: ModelRouteRequest,
  result: ProviderResult,
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
    (result.response ?? "") + JSON.stringify(result.tool_calls ?? []),
  ).length;

  return {
    inputTokens: estimateTokens(promptBytes),
    outputTokens: estimateTokens(completionBytes),
    estimated: true,
  };
}
