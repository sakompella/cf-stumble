import { truncateTail } from "@cf-stumble/pi";
import { isPlainObject } from "./plain-values.js";
import { TOOL_RESULT_DISPLAY_MAX_BYTES, TOOL_RESULT_DISPLAY_MAX_LINES } from "./turn-policy.js";
import type { AgentEvent, AgentMessage } from "@cf-stumble/pi";
import type { PiAgentTurnState } from "./pi-agent-turn.js";

/**
 * One frame of a turn's byte stream.
 *
 * `text` is incremental: one frame per delta the route produced, so a reader renders a reply as it
 * arrives. `tool-start` carries the arguments the model chose, and `tool-result` carries the
 * bounded text the tool answered with, which is what shows a command's output.
 *
 * `diff` is the turn's own statement about what it changed (goal criterion 4). It is not a tool
 * result: the harness runs the diff itself after the model has stopped, so a turn that touched
 * files shows its work whether or not the model asked for it. `diff-unavailable` carries the
 * reason the repository could not answer, because "the diff is missing" and "the diff is empty"
 * are different facts.
 *
 * Exactly one terminal frame ends a stream, and the three kinds are different facts. `rejected`
 * means no turn ran, so there is no conversation to keep. `completed` and `failed` both carry the
 * Pi state the next turn continues from, because a turn that hit its model-call limit or a model
 * error still produced conversation the thread must keep. `completed` is this facet's terminal
 * success and stays provisional until the Supervisor saves the thread (ADR-0037).
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Boundary: Pi types a tool call's arguments as an open value, so the shape is proven here.
function toolArguments(args: unknown): Record<string, unknown> {
  return isPlainObject(args) ? args : {};
}

/**
 * Turns Pi's lifecycle events into frames, remembering how much of the assistant's reply it has
 * already published.
 *
 * A route that streams deltas and a route that answers in one piece both have to produce the same
 * text exactly once. Deltas are published as they arrive; the end of the message publishes only
 * what the deltas did not already cover, which is everything when the reply arrived whole.
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
