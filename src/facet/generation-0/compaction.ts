import {
  compact,
  createCompactionSummaryMessage,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
} from "@cf-stumble/pi";
import type { AgentMessage, AgentState, CompactionSettings, Entry, Models } from "@cf-stumble/pi";

export type CompactionPolicy = Readonly<{
  contextBudgetTokens: number;
  settings: CompactionSettings;
}>;

/**
 * The thread is a flat message list, so every entry's parent is the entry before it. A leading Pi
 * summary message becomes a `compaction` entry so a second compaction updates it instead of
 * summarizing it as conversation.
 */
function sessionEntries(messages: readonly AgentMessage[]): Entry[] {
  const [first, ...rest] = messages;

  if (first?.role !== "compactionSummary") return messageEntries(messages, 0);

  const compaction: Entry = {
    type: "compaction",
    id: "0",
    parentId: null,
    seq: 0,
    timestamp: first.timestamp,
    summary: first.summary,
    tokensBefore: first.tokensBefore,
    retainedTail: [],
    details: {
      readFiles: summaryFileList(first.summary, "read-files"),
      modifiedFiles: summaryFileList(first.summary, "modified-files"),
    },
  };

  return [compaction, ...messageEntries(rest, 1)];
}

function messageEntries(messages: readonly AgentMessage[], firstSeq: number): Entry[] {
  return messages.map((message, index) => {
    const seq = firstSeq + index;

    return {
      type: "message",
      id: `${seq}`,
      parentId: seq === 0 ? null : `${seq - 1}`,
      seq,
      timestamp: message.timestamp,
      message,
    };
  });
}

/** Pi keeps these lists in the compaction entry's details; the saved thread keeps only summary text. */
function summaryFileList(summary: string, tag: "read-files" | "modified-files"): string[] {
  const open = `<${tag}>\n`;
  const start = summary.lastIndexOf(open);

  if (start === -1) return [];
  const end = summary.indexOf(`\n</${tag}>`, start);

  return end === -1 ? [] : summary.slice(start + open.length, end).split("\n");
}

export function estimateThreadTokens(messages: readonly AgentMessage[]): number {
  return estimateContextTokens([...messages]).tokens;
}

/** `shouldCompact` reads `tokens > window - reserveTokens`, so the declared budget sets when a thread compacts. */
export function needsCompaction(
  messages: readonly AgentMessage[],
  policy: CompactionPolicy,
): boolean {
  return shouldCompact(estimateThreadTokens(messages), policy.contextBudgetTokens, policy.settings);
}

/** Returns `undefined` when Pi declines or the summary fails: losing a thread to a failed summary is worse than exceeding the budget. */
export async function compactThread(
  messages: readonly AgentMessage[],
  models: Models,
  model: AgentState["model"],
  policy: CompactionPolicy,
  signal?: AbortSignal,
): Promise<readonly AgentMessage[] | undefined> {
  const prepared = prepareCompaction(sessionEntries(messages), policy.settings);

  if (!prepared.ok || prepared.value === undefined) return undefined;

  // A cut point keeping every message would still cost a summary call and grow the thread.
  const { messagesToSummarize, turnPrefixMessages } = prepared.value;

  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

  // oxlint-disable-next-line typescript/no-unsafe-argument -- Pi declares `AgentState.model` as `Model<any>` and `compact` as `Model<Api>`; this passes one Pi value between two Pi declarations of it.
  const compacted = await compact(prepared.value, models, model, undefined, signal);

  if (!compacted.ok) return undefined;

  const { summary, tokensBefore, retainedTail } = compacted.value;

  return [createCompactionSummaryMessage(summary, tokensBefore, Date.now()), ...retainedTail];
}
