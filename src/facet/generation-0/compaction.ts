import {
  compact,
  createCompactionSummaryMessage,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
} from "@cf-stumble/pi";
import type { AgentMessage, AgentState, CompactionSettings, Entry, Models } from "@cf-stumble/pi";

/**
 * When this generation compacts and how much it keeps. It is a value rather than a constant read
 * from a module so a test can force compaction with a small budget without a long conversation,
 * which is what makes the forced-compaction proof deterministic.
 */
export type CompactionPolicy = Readonly<{
  contextBudgetTokens: number;
  settings: CompactionSettings;
}>;

/**
 * Present the flat message list this generation saves as the session path Pi's compaction reads.
 *
 * Pi's own harness keeps a session tree and compacts a path through it. Generation 0 keeps one
 * linear conversation instead, because the thread is stored outside every generation as a plain
 * message list (ADR-0038), so the path is the whole list and every entry's parent is the entry
 * before it. Projecting it here is what lets Pi's own cut-point and summarization logic run
 * unchanged rather than being reimplemented against a different shape.
 *
 * A thread this generation compacted starts with Pi's summary message, and that message becomes a
 * `compaction` entry. Pi finds a previous summary only through such an entry, so a second
 * compaction then updates the summary with Pi's update prompt instead of summarizing the old
 * summary as if it were conversation. The messages after it follow the entry, which is where Pi's
 * own sessions keep what came after a compaction. The saved thread keeps its format.
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

/**
 * One file list Pi appended to a summary it wrote, read back from the summary's last `<tag>`
 * block. Pi's own sessions keep these lists as the compaction entry's details and merge them into
 * the next summary; the saved thread keeps only the summary text, so they are recovered from it.
 */
function summaryFileList(summary: string, tag: "read-files" | "modified-files"): string[] {
  const open = `<${tag}>\n`;
  const start = summary.lastIndexOf(open);

  if (start === -1) return [];
  const end = summary.indexOf(`\n</${tag}>`, start);

  return end === -1 ? [] : summary.slice(start + open.length, end).split("\n");
}

/** What Pi estimates this conversation costs, using provider usage when a reply reported it. */
export function estimateThreadTokens(messages: readonly AgentMessage[]): number {
  return estimateContextTokens([...messages]).tokens;
}

/**
 * Pi's own compaction decision, asked against this generation's declared budget rather than the
 * route's context window. `ROUTE_MODEL` reports a zero window, and `shouldCompact` reads its
 * argument as `tokens > window - reserveTokens`, so a zero window is not a disabled trigger: it
 * makes every conversation, including an empty one, exceed the threshold.
 */
export function needsCompaction(
  messages: readonly AgentMessage[],
  policy: CompactionPolicy,
): boolean {
  return shouldCompact(estimateThreadTokens(messages), policy.contextBudgetTokens, policy.settings);
}

/**
 * Replace the older part of a conversation with Pi's compaction summary and keep its recent tail.
 *
 * The summary is Pi's: `prepareCompaction` chooses the cut point and `compact` writes the summary
 * through the model, so this generation adds no second summarizer and no second prompt. The one
 * model call it costs goes through `models`, which is the same host route the turn runs on.
 *
 * A conversation Pi declines to compact, and a summarization the route fails to answer, both return
 * `undefined`: the turn then continues on the conversation it already had. Losing a thread to a
 * failed summary would be worse than exceeding a budget this generation set for itself.
 */
export async function compactThread(
  messages: readonly AgentMessage[],
  models: Models,
  model: AgentState["model"],
  policy: CompactionPolicy,
  signal?: AbortSignal,
): Promise<readonly AgentMessage[] | undefined> {
  const prepared = prepareCompaction(sessionEntries(messages), policy.settings);

  if (!prepared.ok || prepared.value === undefined) return undefined;

  // A cut point that keeps every message leaves Pi nothing to summarize. It would still ask the
  // model for a summary, and the thread would grow by that summary instead of shrinking.
  const { messagesToSummarize, turnPrefixMessages } = prepared.value;

  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

  // oxlint-disable-next-line typescript/no-unsafe-argument -- Pi declares `AgentState.model` as `Model<any>` and `compact` as `Model<Api>`; this passes one Pi value between two Pi declarations of it.
  const compacted = await compact(prepared.value, models, model, undefined, signal);

  if (!compacted.ok) return undefined;

  const { summary, tokensBefore, retainedTail } = compacted.value;

  return [createCompactionSummaryMessage(summary, tokensBefore, Date.now()), ...retainedTail];
}
