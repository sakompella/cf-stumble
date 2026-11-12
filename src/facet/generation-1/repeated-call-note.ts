import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry,
  defineExtension,
  hook,
  LiveDoc,
  ToolResultEntry,
  ToolTask,
  type EntryRecord,
  type HookApi,
  type ToolDiagnostic,
  type ToolExecutionResult,
  type ToolHookCall,
} from "@earendil-works/pi-durable";

const EARLIER_REPEATS_BEFORE_NOTE = 2;

const LOOK_BACK_ENTRIES = 200;

const NOTE: ToolDiagnostic = {
  severity: "warn",
  code: "repeated_call",
  message:
    "This run already made this call with the same arguments at least twice and got this same result. Use the result you have, or change the call, instead of running it again.",
};

function callArguments(entries: readonly EntryRecord[]): Map<string, string> {
  const calls = new Map<string, string>();

  for (const entry of entries) {
    const message = entry.model?.[0];

    if (!AssistantEntry.is(entry) || message?.role !== "assistant") continue;

    for (const block of message.content) {
      if (block.type === "toolCall") calls.set(block.id, JSON.stringify(block.arguments));
    }
  }

  return calls;
}

async function earlierRepeats(
  call: ToolHookCall,
  result: ToolExecutionResult,
  api: HookApi,
  context: Context,
): Promise<number> {
  const live = await api.snapshot(LiveDoc, api.conversationId, context);
  const first = live?.run?.first;

  if (first === undefined) return 0;

  const { items } = await api.entries({ minEntryId: first }, LOOK_BACK_ENTRIES, undefined, context);
  const calls = callArguments(items);

  return items.filter((entry) => {
    const message = entry.model?.[0];

    if (!ToolResultEntry.is(entry) || message?.role !== "toolResult") return false;

    const output =
      entry.data.diagnostics.length > 0 ? message.content.slice(0, -1) : message.content;

    return (
      message.toolName === call.name &&
      message.isError === (result.isError ?? false) &&
      JSON.stringify(output) === JSON.stringify(result.output ?? []) &&
      calls.get(message.toolCallId) === JSON.stringify(call.arguments)
    );
  }).length;
}

export const RepeatedCallNote = defineExtension({
  name: "repeated-call-note",
  hooks: [
    hook(ToolTask, {
      afterTool: async (call, result, api, context) =>
        call.parent === undefined &&
        (await earlierRepeats(call, result, api, context)) >= EARLIER_REPEATS_BEFORE_NOTE
          ? { ...result, diagnostics: [...(result.diagnostics ?? []), NOTE] }
          : undefined,
    }),
  ],
});
