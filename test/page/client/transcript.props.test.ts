import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { EMPTY_CONVERSATION } from "../../../src/page/client/conversation.js";
import type { PiMessage } from "../../../src/page/client/pi-message.js";
import { entryItem } from "./views.js";
import { transcriptOf } from "../../../src/page/client/transcript.js";

type Drawn = Readonly<{ isCall: boolean; id: string; isError: boolean }>;

function message({ isCall, id, isError }: Drawn): PiMessage {
  return isCall
    ? {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id, name: "read", arguments: {} }],
      }
    : { role: "toolResult", toolCallId: id, toolName: "read", content: [], isError };
}

function expected(drawn: readonly Drawn[]): readonly string[] {
  const blocks: string[] = [];
  const latest = new Map<string, number>();

  for (const { isCall, id, isError } of drawn) {
    const index = isCall ? blocks.length : (latest.get(id) ?? blocks.length);
    blocks[index] = isCall ? `${id}: read` : `${id}: read — ${isError ? "failed" : "done"}`;
    latest.set(id, index);
  }

  return blocks;
}

test("each tool result finishes the latest block of its call, or opens one at the end", () => {
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 24 }));

      const drawn = Array.from({ length: count }, () => ({
        isCall: tc.draw(gs.booleans()),
        id: tc.draw(gs.sampledFrom(["a", "b", "c"])),
        isError: tc.draw(gs.booleans()),
      }));

      const items = drawn.map((item, index) => entryItem(index + 1, message(item)));

      const shown = transcriptOf({ ...EMPTY_CONVERSATION, items }, [], "repo").map((entry) =>
        entry._tag === "Tool" ? `${entry.toolCallId}: ${entry.summary}` : entry._tag,
      );

      expect(shown).toStrictEqual(expected(drawn));
    },
    { testCases: 300 },
  );
});
