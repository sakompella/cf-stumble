import type { Context } from "@earendil-works/chord";
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

const NO_CONTINUE: Chain = { minutes: RUN_DEADLINE_MINUTES, continues: 0 };

const SCAN_PAGE = 100;

const DEADLINE_STOP = `Harness notice: the run stopped at its ${RUN_DEADLINE_MINUTES}-minute time limit before it finished, so its last step may be incomplete.`;

const DEADLINE_NOTICE = `${DEADLINE_STOP} Send a message to continue.`;

function continuedNotice({ minutes, continues }: Chain): string {
  return `${DEADLINE_STOP} The harness continued it automatically, ${continues * RUN_DEADLINE_MINUTES} of ${minutes} minutes used.`;
}

function chainOf(budgets: Readonly<RunBudgets>, inputs: readonly SubmissionId[]): Chain {
  const newest = inputs.toSorted((a, b) => b - a).find((id) => String(id) in budgets.runs);

  return (newest === undefined ? undefined : budgets.runs[String(newest)]) ?? NO_CONTINUE;
}

export function submitWithBudget(
  conversation: Conversation,
  draft: SubmissionDraft,
  minutes: number | undefined,
  context: Context,
): Promise<SubmissionId> {
  return conversation.commit(async (tx) => {
    const idle = (await tx.doc(LiveDoc, conversation.id)).run === undefined;
    const id = await conversation.submit(tx, draft);
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
): Promise<Chain | undefined> {
  const chain = chainOf(await tx.doc(RunBudgetsDoc, conversationId), failure.inputs);
  const continues = chain.continues + 1;

  return (continues + 1) * RUN_DEADLINE_MINUTES <= chain.minutes &&
    failure.first !== undefined &&
    (await repliedSince(tx, conversationId, failure.first))
    ? { minutes: chain.minutes, continues }
    : undefined;
}

async function startedContinue(
  tx: Tx,
  conversationId: ConversationId,
  id: SubmissionId,
  chain: Chain,
): Promise<void> {
  (await tx.doc(RunBudgetsDoc, conversationId)).runs = { [String(id)]: chain };
}

export function endDeadlineRun(conversation: Conversation, context: Context): Promise<void> {
  return conversation.commit(async (tx) => {
    const failure = (await tx.doc(LiveDoc, conversation.id)).runFailure;
    const latest = await tx.latestEntryId(conversation.id);
    const last = latest === undefined ? undefined : await tx.entry(latest);

    if (
      failure?.reason !== "aborted" ||
      (last?.kind === RUN_NOTICE_KIND && last.data === failure.taskId)
    ) {
      return;
    }

    const chain = await continuedChain(tx, conversation.id, failure);

    if (chain === undefined) {
      await conversation.submit(tx, noticeWrite(DEADLINE_NOTICE, Date.now(), failure.taskId));

      return;
    }

    const id = await conversation.submit(tx, {
      type: "input",
      content: continuedNotice(chain),
      entry: { kind: RUN_NOTICE_KIND, data: failure.taskId },
    });

    await startedContinue(tx, conversation.id, id, chain);
  }, context);
}

export async function continuesOf(
  harness: Harness,
  conversationId: ConversationId,
  placed: readonly SubmissionId[],
  context: Context,
): Promise<number> {
  const budgets = await harness.snapshot(RunBudgetsDoc, conversationId, context);

  return budgets === undefined ? 0 : chainOf(budgets, placed).continues;
}
