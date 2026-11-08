import * as Schema from "effect/Schema";
import { AssistantMessage, type Conversation } from "../../page/index.js";
import { STARTUP_CHECK_REPLY, startupCheckStep } from "../../startup-check-script.js";

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

  const messages = conversationMessages(conversation);

  const final = messages.filter(
    (message) => isAssistantMessage(message) && message.stopReason !== "toolUse",
  );

  const last = messages.at(-1);

  return final.length >= answers && isAssistantMessage(last) && last.stopReason !== "toolUse"
    ? last
    : undefined;
}

export function turnStep(conversation: Conversation, steps: readonly string[]): string {
  const messages = conversationMessages(conversation);
  const turn = messages.slice(messages.findLastIndex((message) => message.role === "user") + 1);

  const calls = turn
    .flatMap((message) => (isAssistantMessage(message) ? message.content : []))
    .flatMap((block) => ("id" in block ? [startupCheckStep(block.id)] : []));

  const answered = turn.filter((message) => "toolCallId" in message).length;
  const last = turn.at(-1);
  const called = calls.at(-1);

  if (called === undefined) return steps[0] ?? "first-reply";

  const finished = isAssistantMessage(last) && last.stopReason !== "toolUse";

  return answered < calls.length || finished
    ? (calls[answered] ?? called)
    : (steps[steps.indexOf(called) + 1] ?? called);
}

function conversationMessages(conversation: Conversation) {
  return conversation.items.flatMap((item) =>
    item.kind === "entry" ? (item.entry.model ?? []) : [],
  );
}

function answerText(answer: AssistantMessage): string {
  const text = answer.content.flatMap((block) => ("text" in block ? [block.text] : [])).join("");

  return text === "" ? (answer.errorMessage ?? "") : text;
}
