import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import type { Conversation } from "./conversation.js";
import { blocksText } from "./pi-message.js";

const sent = {
  requestId: Schema.String,
  projectId: Schema.String,
  text: Schema.String,
  afterEntry: Schema.Number,
  budgetMinutes: Schema.Number,
};

export const Outgoing = defineTaggedUnion({
  Sending: sent,
  Unconfirmed: sent,
  Queued: { ...sent, submissionId: Schema.Number },
});

export type Outgoing = typeof Outgoing.Type;

export const OutgoingEvent = defineTaggedUnion({
  Admitted: { submissionId: Schema.Number },
  Lost: {},
  Retried: {},
  Refused: {},
});

export type OutgoingEvent = typeof OutgoingEvent.Type;

function advance(item: Outgoing, event: OutgoingEvent): Option.Option<Outgoing> {
  const { requestId, projectId, text, afterEntry, budgetMinutes } = item;
  const fields = { requestId, projectId, text, afterEntry, budgetMinutes };

  return Outgoing.match(item, {
    Sending: () =>
      OutgoingEvent.match(event, {
        Admitted: ({ submissionId }) => Option.some(Outgoing.Queued({ ...fields, submissionId })),
        Lost: () => Option.some(Outgoing.Unconfirmed(fields)),
        Retried: () => Option.some(item),
        Refused: () => Option.none(),
      }),
    Unconfirmed: () =>
      OutgoingEvent.match(event, {
        Admitted: ({ submissionId }) => Option.some(Outgoing.Queued({ ...fields, submissionId })),
        Lost: () => Option.some(item),
        Retried: () => Option.some(Outgoing.Sending(fields)),
        Refused: () => Option.none(),
      }),
    Queued: () =>
      OutgoingEvent.match(event, {
        Admitted: () => Option.some(item),
        Lost: () => Option.some(item),
        Retried: () => Option.some(item),
        Refused: () => Option.some(item),
      }),
  });
}

export type Advanced = Readonly<{
  outgoing: readonly Outgoing[];
  before: Option.Option<Outgoing>;
  after: Option.Option<Outgoing>;
}>;

export function advanceRequest(
  outgoing: readonly Outgoing[],
  requestId: string,
  event: OutgoingEvent,
): Advanced {
  const before = Option.fromNullishOr(outgoing.find((item) => item.requestId === requestId));
  const after = Option.flatMap(before, (item) => advance(item, event));

  return {
    outgoing: outgoing.flatMap((item) =>
      item.requestId === requestId ? Option.toArray(after) : [item],
    ),
    before,
    after,
  };
}

export function withoutQueued(outgoing: readonly Outgoing[]): readonly Outgoing[] {
  return outgoing.filter((item) => !Outgoing.guards.Queued(item));
}

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

function unseenOutgoing(
  conversation: Conversation,
  outgoing: readonly Outgoing[],
): readonly Outgoing[] {
  const placed = placedUserTexts(conversation);
  const claimed = new Set<number>();

  return outgoing.filter((item) => {
    const match = placed.find(
      ({ id, text }) => id > item.afterEntry && text === item.text && !claimed.has(id),
    );

    if (match === undefined) return true;

    claimed.add(match.id);

    return false;
  });
}

function isHeld(conversation: Conversation, item: Outgoing): boolean {
  return Outgoing.match(item, {
    Sending: () => true,
    Unconfirmed: () => true,
    Queued: ({ submissionId }) =>
      conversation.isRunning || conversation.inbox.some((queued) => queued.id === submissionId),
  });
}

export function settledOutgoing(
  conversation: Conversation,
  outgoing: readonly Outgoing[],
  projectId: string,
): readonly Outgoing[] {
  return [
    ...outgoing.filter((item) => item.projectId !== projectId),
    ...unseenOutgoing(
      conversation,
      outgoing.filter((item) => item.projectId === projectId),
    ).filter((item) => isHeld(conversation, item)),
  ];
}

export function undisplayedOutgoing(
  conversation: Conversation,
  outgoing: readonly Outgoing[],
  projectId: string,
): readonly Outgoing[] {
  return unseenOutgoing(
    conversation,
    outgoing.filter((item) => item.projectId === projectId),
  ).filter((item) =>
    Outgoing.match(item, {
      Sending: () => true,
      Unconfirmed: () => true,
      Queued: ({ submissionId }) =>
        !conversation.inbox.some((queued) => queued.id === submissionId),
    }),
  );
}
