import {
  getCurrentSystemMessage,
  getCurrentTools,
  getSystemMessageText,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  SystemMessage,
  TextContent,
  ToolResultMessage,
  TranscriptContext,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  ModelRouteRequest,
  RouteMessage,
  ToolDefinition,
} from "../../model-route-wire/request.js";

type Block = TextContent | ImageContent;

function blockText(block: Block): string {
  return block.type === "text"
    ? block.text
    : `[Image omitted (${block.mimeType}): this model route carries text only.]`;
}

function contentText(content: UserMessage["content"] | ToolResultMessage["content"]): string {
  return Array.isArray(content) ? content.map((block) => blockText(block)).join("") : content;
}

function assistantMessage(message: AssistantMessage): RouteMessage {
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));

  return {
    role: "assistant",
    content: text.length > 0 ? text.join("") : null,
    tool_calls: message.content.flatMap((block) =>
      block.type === "toolCall"
        ? [
            {
              id: block.id,
              function: { name: block.name, arguments: JSON.stringify(block.arguments) },
            },
          ]
        : [],
    ),
  };
}

function routeMessage(message: Exclude<Message, SystemMessage>): RouteMessage {
  if (message.role === "user") return { role: "user", content: contentText(message.content) };

  if (message.role === "assistant") return assistantMessage(message);

  return { role: "tool", tool_call_id: message.toolCallId, content: contentText(message.content) };
}

export function transcriptToRouteRequest(context: TranscriptContext): ModelRouteRequest {
  const head = getCurrentSystemMessage(context.messages);
  const system = head === undefined ? "" : getSystemMessageText(head);

  const messages = context.messages.flatMap((message) =>
    message.role === "system" ? [] : [routeMessage(message)],
  );

  const tools = getCurrentTools(context.messages).map((tool): ToolDefinition => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toToolDeclaration(tool).parameters,
    },
  }));

  return {
    messages: system === "" ? messages : [{ role: "system", content: system }, ...messages],
    ...(tools.length > 0 && { tools }),
  };
}
