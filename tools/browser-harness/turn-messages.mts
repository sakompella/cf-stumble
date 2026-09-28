import type { ProjectTurnFrame } from "../../src/supervisor/projects/turn-frames.js";

/**
 * The Pi messages a streamed turn leaves in the saved thread.
 *
 * The stub stores what it streamed rather than a count, so a page that reloads after a turn reads
 * back the owner's own prompt and the reply it watched arrive. The grouping follows Pi: one
 * assistant message runs until a tool result, each result is its own `toolResult` message, and
 * the next text or tool call opens a new assistant message. Diff and terminal frames are the
 * Supervisor's statements about the turn, not messages, so they store nothing.
 */

type TextBlock = Readonly<{ type: "text"; text: string }>;

type ToolArguments = Extract<ProjectTurnFrame, { kind: "tool-start" }>["arguments"];

type AssistantBlock =
  | TextBlock
  | Readonly<{
      type: "toolCall";
      id: string;
      name: string;
      arguments: ToolArguments;
    }>;

export type StoredMessage =
  | Readonly<{ role: "user" | "assistant"; content: readonly AssistantBlock[] }>
  | Readonly<{
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: readonly TextBlock[];
      isError: boolean;
    }>;

export function textMessage(role: "user" | "assistant", text: string): StoredMessage {
  return { role, content: [{ type: "text", text }] };
}

/** A text frame continues the text block it follows, as the page renders it. */
function withText(blocks: readonly AssistantBlock[], text: string): readonly AssistantBlock[] {
  const last = blocks.at(-1);

  return last?.type === "text"
    ? [...blocks.slice(0, -1), { type: "text", text: last.text + text }]
    : [...blocks, { type: "text", text }];
}

export function turnMessages(
  prompt: string,
  frames: readonly ProjectTurnFrame[],
): readonly StoredMessage[] {
  const messages: StoredMessage[] = [textMessage("user", prompt)];
  let assistant: readonly AssistantBlock[] = [];

  const closeAssistant = (): void => {
    if (assistant.length > 0) {
      messages.push({ role: "assistant", content: assistant });
      assistant = [];
    }
  };

  for (const frame of frames) {
    if (frame.kind === "text") {
      assistant = withText(assistant, frame.text);
    } else if (frame.kind === "tool-start") {
      const call = { type: "toolCall", id: frame.toolCallId, name: frame.toolName } as const;
      assistant = [...assistant, { ...call, arguments: frame.arguments }];
    } else if (frame.kind === "tool-result") {
      closeAssistant();
      messages.push({
        role: "toolResult",
        toolCallId: frame.toolCallId,
        toolName: frame.toolName,
        content: [{ type: "text", text: frame.content }],
        isError: frame.isError,
      });
    }
  }

  closeAssistant();

  return messages;
}
