import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  assertAtMost,
  assertExcludes,
  assertIncludes,
  assertNonEmpty,
  assertSame,
  byId,
  completeTurn,
  LONG_LINE_END_MARKER,
  LONG_LINE_START_MARKER,
  openTool,
  readConversation,
  readFocus,
  readPageMetrics,
  readThread,
  readTools,
  readTurn,
  sendPrompt,
  sleep,
  waitForText,
  waitForTurnEnded,
  FRAME_INTERVAL_MS,
  type HarnessCase,
} from "../harness.mjs";
import { assertToolsDone, clickFresh, freshPosts, SAVED_STATE } from "./_chat.mjs";

/**
 * The bounds that keep a long turn readable: output the page shortens before it lays it out, and a
 * tool result that stays collapsed until a reader opens it.
 *
 * Both are about the browser rather than the protocol. The Supervisor already limits what a tool
 * may return, and these cases are the second limit — what one document can lay out without
 * widening the page, freezing the keyboard, or burying the composer.
 */
export const CASES: readonly HarnessCase[] = [
  {
    id: "CHAT-12",
    title: "a long single line is bounded",
    rank: "should",
    scenario: "long-line",
    run: async ({ page }) => {
      await completeTurn(page, "Run the build");
      await openTool(page, 0);
      const tools = await readTools(page);
      const output = tools[0]?.output ?? "";

      assert(
        output.startsWith(LONG_LINE_START_MARKER),
        `the opened output: expected it to start "${LONG_LINE_START_MARKER}", read "${output.slice(0, 40)}"`,
      );
      assertExcludes(output, LONG_LINE_END_MARKER, "the opened output");
      assertSame(tools[0]?.displayShortened ?? false, true, "the shortened-for-display note");
      assertAtMost(output.length, 20_100, "characters rendered for the long line");

      const metrics = await readPageMetrics(page);
      assertAtMost(metrics.horizontalOverflow, 1, "horizontal document overflow");

      await page.press("Tab");
      const moved = await readFocus(page);
      assert(
        moved.id !== "" || moved.tag !== "body",
        "Tab moved focus nowhere after the long line",
      );
      assertSame(moved.visible, true, "the focused control after the long line");

      await page.click(byId(ID.sendTurnButton));
      await waitForText(page, ID.turnState, "type a prompt first");

      return `${output.length} characters were rendered with the shortening note, the document did not overflow, focus advanced to ${moved.id === "" ? moved.tag : moved.id}, and the empty Send answered "type a prompt first"`;
    },
  },
  {
    id: "CHAT-13",
    title: "tool disclosures are compact and expose failures",
    rank: "should",
    scenario: "ready",
    run: async ({ page, reopen }) => {
      await completeTurn(page, "Add the project sidebar");
      const closed = await readTools(page);
      assertSame(closed.length, 3, "tool disclosures");
      assertSame(
        closed.filter((tool) => tool.open).length,
        0,
        "tool disclosures opened by the page itself",
      );
      assertToolsDone(closed);
      assertSame(closed[2]?.serverTruncated ?? false, true, "the server-truncated note");
      assertSame(closed[2]?.displayShortened ?? false, true, "the shortened-for-display note");

      await openTool(page, 2);
      assertSame(
        (await readTools(page)).filter((tool) => tool.open).length,
        1,
        "open tool disclosures after one click",
      );

      await reopen("tool-failed");
      await completeTurn(page, "Run the check");
      const failed = await readTools(page);
      assertSame(failed.length, 1, "tool disclosures in the failed turn");
      assertSame(failed[0]?.open ?? false, true, "the failed tool disclosure");
      assertSame(failed[0]?.failed ?? false, true, "the failed styling on the tool");
      assert(
        (failed[0]?.summary ?? "").endsWith("— failed"),
        `the failed tool summary: read "${failed[0]?.summary ?? ""}"`,
      );
      assertNonEmpty(failed[0]?.output ?? "", "the failed tool output");
      assertAtMost(failed[0]?.outputLength ?? 0, 500, "characters in the failed tool output");

      return `three successful tools arrived closed and ended "— done", the large one carried both truncation notes, and the failed tool arrived open and ended "— failed"`;
    },
  },
  {
    id: "CHAT-14",
    title: "fresh thread requires confirmation and no running turn",
    rank: "should",
    scenario: "ready-paused",
    run: async ({ page, server }) => {
      await sendPrompt(page, "Add the project sidebar");
      await server.waitForBarrier();
      await sleep(FRAME_INTERVAL_MS);
      await clickFresh(page);
      assertSame(
        (await readThread(page)).freshStatus,
        "a turn is running; cancel it first",
        "the fresh-thread status during a turn",
      );
      assertSame(freshPosts(server), 0, "fresh-thread requests sent during a turn");

      server.release();
      await waitForTurnEnded(page);
      assertSame((await readTurn(page)).turnState, SAVED_STATE, "the terminal turn state");
      await waitForText(page, ID.threadRevision, "4");

      const streamed = await readConversation(page);
      await clickFresh(page);
      await waitForText(page, ID.freshThreadStatus, "click again to replace this conversation");
      assertSame(
        (await readConversation(page)).messages,
        streamed.messages,
        "transcript entries after one activation",
      );
      assertSame(freshPosts(server), 0, "fresh-thread requests after one activation");

      await clickFresh(page);
      await waitForText(page, ID.freshThreadStatus, "fresh thread started");
      const thread = await readThread(page);
      assertSame(freshPosts(server), 1, "fresh-thread requests after confirming");
      assertIncludes(
        thread.freshStatus,
        "repository files are untouched",
        "the fresh-thread status",
      );
      assertSame(thread.revision, "5", "the thread revision after a fresh thread");
      assertSame(thread.messageCount, "0", "the message count after a fresh thread");
      assertSame((await readConversation(page)).messages, 0, "transcript entries after confirming");

      return `the running turn refused the reset, one activation only warned, and the second sent exactly one fresh POST reaching revision 5 with zero messages`;
    },
  },
];
