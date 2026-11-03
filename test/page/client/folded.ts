import { ConversationTranscript } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import { EMPTY_CONVERSATION, type Conversation } from "../../../src/page/client/conversation.js";
import { viewReader } from "../../../src/page/client/view-reader.js";

export function folded(lines: readonly string[]): readonly Conversation[] {
  const transcript = new ConversationTranscript(() => Promise.reject(new Error("no history")));
  const read = viewReader({ transcript, latest: undefined });

  return lines.map((line) => {
    const conversation = read(line);

    if (Option.isNone(conversation)) throw new Error(`the page could not read ${line}`);

    return conversation.value;
  });
}

export function lastFolded(lines: readonly string[]): Conversation {
  return folded(lines).at(-1) ?? EMPTY_CONVERSATION;
}
