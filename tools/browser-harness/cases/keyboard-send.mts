import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  assertIncludes,
  assertSame,
  assertRequestBody,
  focusDocument,
  readConversation,
  readThread,
  readTurn,
  selectRequestsLike,
  tabUntil,
  waitForSettledReads,
  waitForTurnEnded,
  type HarnessCase,
} from "../harness.mjs";

export const CASES: readonly HarnessCase[] = [
  {
    id: "KEY-3",
    title: "Control-Enter sends exactly once",
    rank: "should",
    scenario: "ready-paused",
    run: async ({ page, server }) => {
      await focusDocument(page);
      const route = await tabUntil(page, (stop) => stop.id === ID.promptInput);
      assert(route.length > 0, "keyboard route to the prompt was empty");
      await page.insertText("Keyboard turn");
      await page.press("Enter", ["Control"]);
      const immediate = await readThread(page);
      assertSame(immediate.prompt, "", "prompt after Control-Enter");
      await server.waitForBarrier();
      const held = await readTurn(page);
      const conversation = await readConversation(page);
      assertSame(held.turnState, "running", "turn state at the stream barrier");
      assertSame(held.sendDisabled, true, "Send while Control-Enter turn runs");
      assertSame(held.cancelDisabled, false, "Cancel while Control-Enter turn runs");
      assertIncludes(conversation.allText, "Keyboard turn", "keyboard-sent transcript");
      assert(held.assistantCharacters > 0, "assistant text was absent at the stream barrier");
      const posts = selectRequestsLike(server.requests(), "POST", "/turn");
      assertSame(posts.length, 1, "turn POST count");
      assertRequestBody(posts[0], { prompt: "Keyboard turn" }, "Control-Enter turn");
      server.release();
      await waitForTurnEnded(page);
      assertSame(
        (await readTurn(page)).turnState,
        "saved · revision 4 · 6 messages",
        "keyboard turn ending",
      );
      await waitForSettledReads(page);
      return `Control-Enter sent one exact turn request; the prompt cleared and ${held.assistantCharacters} assistant characters were visible before release`;
    },
  },
];
