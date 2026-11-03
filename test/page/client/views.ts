import * as Option from "effect/Option";
import { Scene } from "foldkit/test";
import { EMPTY_CONVERSATION, type Conversation } from "../../../src/page/client/conversation.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { FollowTranscript } from "../../../src/page/client/mount.js";
import { transcriptOf } from "../../../src/page/client/transcript.js";
import { init, update } from "../../../src/page/client/update.js";
import type { AssistantMessage, PiMessage } from "../../../src/page/client/pi-message.js";

export function entryItem(
  id: number,
  ...model: readonly PiMessage[]
): Conversation["items"][number] {
  return { kind: "entry", entry: { id, kind: "pi.test", model } };
}

export function viewing(change: Partial<Conversation> = {}): Conversation {
  return { ...EMPTY_CONVERSATION, ...change };
}

export function running(change: Partial<Conversation> = {}): Conversation {
  return viewing({ isRunning: true, ...change });
}

export function streaming(text: string): Option.Option<AssistantMessage> {
  return Option.some({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "pending",
  });
}

export function received(model: Model, conversation: Conversation): Message {
  return Message.ReceivedConversation({ streamId: model.eventsStreamId, conversation });
}

export type { Conversation };

export const followResolved = Scene.Mount.resolve(
  FollowTranscript,
  Message.CompletedFollowTranscript(),
);

export function pageShowing(conversation: Conversation): Model {
  const listed = update(
    init().model,
    Message.SucceededFetchProjects({
      projects: [
        { id: "repo", displayName: "repo", isHarness: false, location: "/workspace/repo" },
      ],
    }),
  ).model;

  return update(listed, received(listed, conversation)).model;
}

export function whoShown(model: Model): readonly string[] {
  return transcriptOf(model.conversation, model.outbox).map((entry) =>
    entry._tag === "Text" ? entry.who : entry._tag,
  );
}
