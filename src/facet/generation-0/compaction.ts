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
 */
function sessionEntries(messages: readonly AgentMessage[]): Entry[] {
  return messages.map((message, index) => ({
    type: "message",
    id: `${index}`,
    parentId: index === 0 ? null : `${index - 1}`,
    seq: index,
    timestamp: message.timestamp,
    message,
  }));
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

  // oxlint-disable-next-line typescript/no-unsafe-argument -- Pi declares `AgentState.model` as `Model<any>` and `compact` as `Model<Api>`; this passes one Pi value between two Pi declarations of it.
  const compacted = await compact(prepared.value, models, model, undefined, signal);

  if (!compacted.ok) return undefined;

  const { summary, tokensBefore, retainedTail } = compacted.value;

  return [createCompactionSummaryMessage(summary, tokensBefore, Date.now()), ...retainedTail];
}
