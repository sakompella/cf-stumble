import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  byId,
  selectRequestsLike,
  type BrowserPage,
  type HarnessScenario,
  type HarnessServer,
  type ToolSnapshot,
} from "../harness.mjs";

/**
 * What the chat cases share: the prompt they send, the wording the page must produce, and the two
 * tables of endings.
 *
 * The endings are data because the assertion is the same for all of them and only the wording
 * differs. A case that spelled each one out would hide that: the point of CHAT-5 is that five
 * endings are five distinct sentences, none of which looks saved.
 */

export const PROMPT = "Add the project sidebar";
export const SAVED_STATE = "saved · revision 4 · 6 messages";

export const NON_SUCCESS_ENDINGS: readonly Readonly<{
  scenario: HarnessScenario;
  state: string;
}>[] = [
  { scenario: "turn-failed", state: "failed: model-error · saved at revision 4" },
  { scenario: "save-failed", state: "not saved: stale-revision" },
  { scenario: "stream-invalid", state: "unreadable turn stream: malformed-frame" },
  { scenario: "cancelled", state: "cancelled" },
  { scenario: "timed-out", state: "timed out" },
];

export const REFUSALS: readonly Readonly<{ scenario: HarnessScenario; state: string }>[] = [
  { scenario: "turn-conflict", state: "busy: another turn holds this project" },
  {
    scenario: "no-active-generation",
    state: "no active generation: activate one in the generation controls",
  },
];

export function assertToolsDone(tools: readonly ToolSnapshot[]): void {
  for (const [index, tool] of tools.entries()) {
    assert(
      tool.summary.endsWith("— done"),
      `tool ${index} summary: expected it to end "— done", read "${tool.summary}"`,
    );
  }
}

export function clickFresh(page: BrowserPage): Promise<void> {
  return page.click(byId(ID.freshThreadButton));
}

export function freshPosts(server: HarnessServer): number {
  return selectRequestsLike(server.requests(), "POST", "/thread/fresh").length;
}
