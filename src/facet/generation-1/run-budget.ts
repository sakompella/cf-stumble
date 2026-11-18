import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDoc,
  LiveDoc,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Harness,
  type RunFailure,
  type SubmissionDraft,
  type SubmissionId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { RunningConversation } from "../conversation-protocol.js";
import { RUN_DEADLINE_MINUTES } from "../../turn-budget.js";
import { RUN_NOTICE_KIND } from "../../run-notice.js";
import { noticeWrite } from "./run-notices.js";

type Chain = { minutes: number; continues: number };

type RunBudgets = { runs: Record<string, Chain> };

const RunBudgetsDoc = defineDoc<RunBudgets>({
  kind: "cf-stumble.run-budgets",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ runs: {} }),
  checkpointWhen: () => true,
});

const SCAN_PAGE = 100;

const DEADLINE_STOP = `Harness notice: the run stopped at its ${RUN_DEADLINE_MINUTES}-minute time limit before it finished, so its last step may be incomplete.`;

const DEADLINE_NOTICE = `${DEADLINE_STOP} Send a message to continue.`;

function continuedNotice({ minutes, continues }: Chain): string {
  return `${DEADLINE_STOP} The harness continued it automatically, ${continues * RUN_DEADLINE_MINUTES} of ${minutes} minutes used.`;
}

function chainOf(
  budgets: Readonly<RunBudgets>,
  inputs: readonly SubmissionId[],
): Chain | undefined {
  const newest = inputs.toSorted((a, b) => b - a).find((id) => String(id) in budgets.runs);

  return newest === undefined ? undefined : budgets.runs[String(newest)];
}

export function submitWithBudget(
  conversation: Conversation,
  draft: SubmissionDraft,
  minutes: number | undefined,
  context: Context,
): Promise<SubmissionId> {
  return conversation.commit(async (tx) => {
    const retried =
      draft.requestId !== undefined &&
      (await tx.submissionByRequest(conversation.id, draft.requestId)) !== undefined;

    const idle = (await tx.doc(LiveDoc, conversation.id)).run === undefined;
    const id = await conversation.submit(tx, draft);

    if (retried) return id;

    const budgets = await tx.doc(RunBudgetsDoc, conversation.id);

    const runs = idle ? {} : budgets.runs;

    budgets.runs = {
      ...runs,
      [String(id)]: { minutes: minutes ?? RUN_DEADLINE_MINUTES, continues: 0 },
    };

    return id;
  }, context);
}

async function repliedSince(tx: Tx, conversationId: ConversationId, first: EntryId) {
  let cursor: Cursor | undefined;

  do {
    const page = await tx.scanEntries(
      { conversationId, minEntryId: first, order: "descending" },
      SCAN_PAGE,
      cursor,
    );

    const replied = page.items.some((entry) => {
      const message = entry.model?.[0];

      return (
        AssistantEntry.is(entry) &&
        message?.role === "assistant" &&
        message.stopReason !== "aborted" &&
        message.stopReason !== "error"
      );
    });

    if (replied) return true;

    cursor = page.next;
  } while (cursor !== undefined);

  return false;
}

async function continuedChain(
  tx: Tx,
  conversationId: ConversationId,
  failure: RunFailure,
  chain: Chain,
): Promise<Chain | undefined> {
  const continues = chain.continues + 1;

  return (continues + 1) * RUN_DEADLINE_MINUTES <= chain.minutes &&
    failure.first !== undefined &&
    (await repliedSince(tx, conversationId, failure.first))
    ? { minutes: chain.minutes, continues }
    : undefined;
}

async function replaceBudgets(
  tx: Tx,
  conversationId: ConversationId,
  runs: RunBudgets["runs"],
): Promise<void> {
  (await tx.doc(RunBudgetsDoc, conversationId)).runs = runs;
}

export function cancelBudget(conversation: Conversation, context: Context): Promise<void> {
  return conversation.commit((tx) => replaceBudgets(tx, conversation.id, {}), context);
}

export function endDeadlineRun(
  conversation: Conversation,
  context: Context,
): Promise<RunningConversation | null> {
  return conversation.commit(async (tx) => {
    const failure = (await tx.doc(LiveDoc, conversation.id)).runFailure;

    if (failure?.reason !== "aborted") return null;

    const budget = chainOf(await tx.doc(RunBudgetsDoc, conversation.id), failure.inputs);

    if (budget === undefined) return null;

    const chain = await continuedChain(tx, conversation.id, failure, budget);

    if (chain === undefined) {
      await conversation.submit(tx, noticeWrite(DEADLINE_NOTICE, Date.now(), failure.taskId));
      await replaceBudgets(tx, conversation.id, {});

      return null;
    }

    const id = await conversation.submit(tx, {
      type: "input",
      content: continuedNotice(chain),
      entry: { kind: RUN_NOTICE_KIND, data: failure.taskId },
    });

    await replaceBudgets(tx, conversation.id, { [String(id)]: chain });

    return { conversationId: String(conversation.id), run: id, continues: chain.continues };
  }, context);
}

export async function continuesOf(
  harness: Harness,
  conversationId: ConversationId,
  placed: readonly SubmissionId[],
  context: Context,
): Promise<number> {
  const budgets = await harness.snapshot(RunBudgetsDoc, conversationId, context);

  return budgets === undefined ? 0 : (chainOf(budgets, placed)?.continues ?? 0);
}
