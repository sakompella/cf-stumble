import { truncateTail } from "@cf-stumble/pi";
import { isRecord } from "../../untrusted.js";
import { TOOL_RESULT_DISPLAY_MAX_BYTES, TOOL_RESULT_DISPLAY_MAX_LINES } from "./turn-policy.js";
import type { AgentEvent, AgentMessage } from "@cf-stumble/pi";
import type { PiAgentTurnState } from "./pi-agent-turn.js";

/**
 * `diff` is the turn's own statement, not a tool result. `diff-unavailable` carries a reason because a
 * missing diff and an empty diff are different facts. Exactly one terminal frame ends a stream:
 * `rejected` carries no conversation, `completed` and `failed` carry the Pi state the next turn
 * continues from.
 */
export type FacetTurnFrame =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{
      kind: "tool-start";
      toolCallId: string;
      toolName: string;
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- The model chose these arguments; their shape is the tool's, not this frame's.
      arguments: Record<string, unknown>;
    }>
  | Readonly<{
      kind: "tool-result";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      content: string;
      truncated: boolean;
    }>
  | Readonly<{ kind: "diff"; content: string; truncated: boolean }>
  | Readonly<{ kind: "diff-unavailable"; detail: string }>
  | Readonly<{ kind: "completed"; state: PiAgentTurnState }>
  | Readonly<{ kind: "failed"; code: "model-call-limit" | "model-error"; state: PiAgentTurnState }>
  | Readonly<{ kind: "rejected"; code: "invalid-project-capability" | "invalid-turn-request" }>;

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";

  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function toolResultText(message: Extract<AgentMessage, { role: "toolResult" }>): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- A tool call's arguments are whatever JSON the model wrote, and keep that shape with each string bounded.
function boundedArgument(value: unknown): unknown {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Any string in the model's JSON may be the large one.
  if (typeof value === "string") {
    return truncateTail(value, {
      maxLines: TOOL_RESULT_DISPLAY_MAX_LINES,
      maxBytes: TOOL_RESULT_DISPLAY_MAX_BYTES,
    }).content;
  }

  if (Array.isArray(value)) return value.map((item) => boundedArgument(item));

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, boundedArgument(item)]),
    );
  }

  return value;
}

/** Strings are bounded like tool results so a `write` of a large file cannot outgrow the Supervisor's progress frame bound. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Boundary: Pi types a tool call's arguments as an open value, so the shape is proven here.
function toolArguments(args: unknown): Record<string, unknown> {
  return isRecord(args)
    ? Object.fromEntries(Object.entries(args).map(([key, item]) => [key, boundedArgument(item)]))
    : {};
}

/**
 * Deltas are published as they arrive; the end of the message publishes only what deltas did not cover,
 * so a route that streams and a route that answers whole both produce the text exactly once.
 */
export class TurnFrames {
  #publishedTextLength = 0;

  frames(event: AgentEvent): readonly FacetTurnFrame[] {
    switch (event.type) {
      case "message_start":
        this.#publishedTextLength = 0;

        return [];
      case "message_update":
        return this.#update(event.assistantMessageEvent);
      case "message_end":
        return this.#end(event.message);
      case "tool_execution_start":
        return [
          {
            kind: "tool-start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: toolArguments(event.args),
          },
        ];
      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "tool_execution_update":
      case "tool_execution_end":
        return [];
      default: {
        // oxlint-disable-next-line eslint/no-underscore-dangle -- Exhaustiveness guard: underscore signals the value is never reached.
        const _exhaustive: never = event;
        void _exhaustive;

        return [];
      }
    }
  }

  #update(
    assistantEvent: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"],
  ) {
    if (assistantEvent.type !== "text_delta" || assistantEvent.delta === "") return [];
    this.#publishedTextLength += assistantEvent.delta.length;

    return [{ kind: "text", text: assistantEvent.delta } as const];
  }

  #end(message: AgentMessage): readonly FacetTurnFrame[] {
    if (message.role === "toolResult") {
      const truncation = truncateTail(toolResultText(message), {
        maxLines: TOOL_RESULT_DISPLAY_MAX_LINES,
        maxBytes: TOOL_RESULT_DISPLAY_MAX_BYTES,
      });

      return [
        {
          kind: "tool-result",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          content: truncation.content,
          truncated: truncation.truncated,
        },
      ];
    }

    const text = assistantText(message);
    const remainder = text.slice(this.#publishedTextLength);
    this.#publishedTextLength = 0;

    return remainder === "" ? [] : [{ kind: "text", text: remainder }];
  }
}
