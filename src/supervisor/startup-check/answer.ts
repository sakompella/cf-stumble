import * as Schema from "effect/Schema";
import { AssistantMessage, type Conversation } from "../../page/index.js";
import { STARTUP_CHECK_REPLY } from "../../startup-check-script.js";

const isAssistantMessage = Schema.is(AssistantMessage);

export function isReply(answer: AssistantMessage): boolean {
  return answer.stopReason === "stop" && answerText(answer) === STARTUP_CHECK_REPLY;
}

export function describe(answer: AssistantMessage): string {
  return `${answer.stopReason}: ${answerText(answer)}`;
}

export function finalAnswer(
  conversation: Conversation,
  answers: number,
): AssistantMessage | undefined {
  if (conversation.isRunning) return undefined;

  const messages = conversation.items.flatMap((item) =>
    item.kind === "entry" ? (item.entry.model ?? []) : [],
  );

  const final = messages.filter(
    (message) => isAssistantMessage(message) && message.stopReason !== "toolUse",
  );

  const last = messages.at(-1);

  return final.length >= answers && isAssistantMessage(last) && last.stopReason !== "toolUse"
    ? last
    : undefined;
}

function answerText(answer: AssistantMessage): string {
  const text = answer.content.flatMap((block) => ("text" in block ? [block.text] : [])).join("");

  return text === "" ? (answer.errorMessage ?? "") : text;
}
