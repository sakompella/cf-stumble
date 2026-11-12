import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  LiveDoc,
  runEndTask,
  type Conversation,
  type SubmissionDraft,
  type TaskId,
} from "@earendil-works/pi-durable";
import { PROJECT_RUN_DEADLINE_MS } from "../../turn-budget.js";
import { RUN_NOTICE_KIND } from "../../run-notice.js";

const RUN_DEADLINE_MINUTES = PROJECT_RUN_DEADLINE_MS / 60_000;

const DEADLINE_NOTICE = `Harness notice: the run stopped at its ${RUN_DEADLINE_MINUTES}-minute time limit before it finished, so its last step may be incomplete. Send a message to continue.`;

const LENGTH_NOTICE =
  "Harness notice: the reply was cut off at the model's output length limit before it finished. Send a message to continue.";

function noticeWrite(text: string, now: number, failedTask: TaskId | null): SubmissionDraft {
  return {
    type: "write",
    entry: {
      kind: RUN_NOTICE_KIND,
      data: failedTask,
      model: [{ role: "user", content: text, timestamp: now }],
    },
  };
}

const LengthNoticeTask = defineTask<null, { phase: "write" }, null>({
  name: "cf-stumble.length-notice",
  version: 1,
  initial: () => ({ phase: "write" }),
  phases: {
    write: async (_task, runtime, context) => {
      const conversation = await runtime.conversation(runtime.conversationId, context);

      await runtime.commit(async (tx) => {
        await conversation?.submit(tx, noticeWrite(LENGTH_NOTICE, runtime.now(), null));

        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export const RunNotices = defineExtension({
  name: "cf-stumble-run-notices",
  tasks: [LengthNoticeTask],
  hooks: [
    hook(GenerationTask, {
      afterRun: async (run, api, context) => {
        const message = (await api.entry(AssistantEntry, run.answer, context))?.model?.[0];

        return message?.role === "assistant" && message.stopReason === "length"
          ? { tasks: [runEndTask(LengthNoticeTask, null)] }
          : undefined;
      },
    }),
  ],
});

export function noticeDeadlineAbort(conversation: Conversation, context: Context): Promise<void> {
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

    await conversation.submit(tx, noticeWrite(DEADLINE_NOTICE, Date.now(), failure.taskId));
  }, context);
}
