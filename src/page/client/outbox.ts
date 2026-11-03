import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Conversation } from "./conversation.js";
import { blocksText } from "./pi-message.js";

export const OutboxItem = Schema.Struct({
  requestId: Schema.String,
  text: Schema.String,
  maybeSubmissionId: Schema.Option(Schema.Number),
  afterEntry: Schema.Number,
});

export type OutboxItem = typeof OutboxItem.Type;

function placedUserTexts(
  conversation: Conversation,
): readonly Readonly<{ id: number; text: string }>[] {
  return conversation.items.flatMap((item) =>
    item.kind === "entry"
      ? (item.entry.model ?? []).flatMap((message) =>
          message.role === "user" && "content" in message
            ? [
                {
                  id: item.entry.id,
                  text: Predicate.isString(message.content)
                    ? message.content
                    : blocksText(message.content),
                },
              ]
            : [],
        )
      : [],
  );
}

export function unseenOutbox(
  conversation: Conversation,
  outbox: readonly OutboxItem[],
): readonly OutboxItem[] {
  const placed = placedUserTexts(conversation);
  const claimed = new Set<number>();

  return outbox.filter((item) => {
    const match = placed.find(
      ({ id, text }) => id > item.afterEntry && text === item.text && !claimed.has(id),
    );

    if (match === undefined) return true;

    claimed.add(match.id);

    return false;
  });
}

export function undisplayedOutbox(
  conversation: Conversation,
  outbox: readonly OutboxItem[],
): readonly OutboxItem[] {
  return unseenOutbox(conversation, outbox).filter((item) =>
    Option.match(item.maybeSubmissionId, {
      onNone: () => true,
      onSome: (id) => !conversation.inbox.some((queued) => queued.id === id),
    }),
  );
}
