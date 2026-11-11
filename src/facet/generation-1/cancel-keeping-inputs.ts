import type { Context } from "@earendil-works/chord/context";
import { InboxDoc, UserEntry, type Conversation } from "@earendil-works/pi-durable";

export async function cancelKeepingInputs(
  conversation: Conversation,
  context: Context,
): Promise<void> {
  const kept = conversation.commit(async (tx) => {
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const timestamp = Date.now();

    for (const item of inbox.items) {
      if (item.mode === "write") continue;

      const entry = await tx.appendEntry(UserEntry, conversation.id, {
        model: [{ role: "user", content: item.content, timestamp }],
      });

      tx.placeSubmission(item.id, entry.id);
      tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
    }

    inbox.items = inbox.items.filter((item) => item.mode === "write");
  }, context);

  const ended = conversation.abort(context);

  await Promise.all([kept, ended]);
}
