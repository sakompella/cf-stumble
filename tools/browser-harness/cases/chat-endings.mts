import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  assertAtLeast,
  assertNonEmpty,
  assertSame,
  byId,
  completeTurn,
  HARNESS_PROJECT_ID,
  readConversation,
  readDiffs,
  readGeneration,
  readThread,
  readTranscript,
  readTurn,
  sendPrompt,
  sleep,
  waitForTurnEnded,
  FRAME_INTERVAL_MS,
  type HarnessCase,
} from "../harness.mjs";
import { NON_SUCCESS_ENDINGS, PROMPT, SAVED_STATE } from "./_chat.mjs";

/**
 * How a turn ends when it does not save.
 *
 * Each ending is a different fact about the project's stored state, so the page may not blur them
 * into one apology: a failed save left the thread where it was, a cancelled turn was stopped by
 * this browser, and a stream that simply stopped never said anything at all. Every one of them has
 * to leave the composer usable, because an accurate message that locks the page is not usable.
 */
export const CASES: readonly HarnessCase[] = [
  {
    id: "CHAT-5",
    title: "non-success terminal frames remain distinct",
    rank: "should",
    scenario: "turn-failed",
    timeoutMs: 120_000,
    run: async ({ page, server, reopen }) => {
      const observed: string[] = [];

      for (const ending of NON_SUCCESS_ENDINGS) {
        await reopen(ending.scenario);
        await completeTurn(page, PROMPT);
        const turn = await readTurn(page);
        const entries = await readTranscript(page);
        assertSame(turn.turnState, ending.state, `the ${ending.scenario} turn state`);
        assertSame(
          entries.at(-1)?.kind ?? "",
          "terminal problem",
          `the final ${ending.scenario} transcript entry`,
        );
        assertSame(turn.sendDisabled, false, `Send after a ${ending.scenario} ending`);
        assertSame(turn.cancelDisabled, true, `Cancel after a ${ending.scenario} ending`);

        if (ending.scenario === "save-failed") {
          assertSame(
            server.thread(HARNESS_PROJECT_ID).revision,
            3,
            "the stored revision after a failed save",
          );
        }

        observed.push(`${ending.scenario} → "${turn.turnState}"`);
      }

      await reopen("ready");
      await completeTurn(page, PROMPT);
      assertSame(
        (await readTurn(page)).turnState,
        SAVED_STATE,
        "the turn state after a ready turn following a failure",
      );

      return `${observed.join("; ")}; a ready turn then reached ${SAVED_STATE}`;
    },
  },
  {
    id: "CHAT-6",
    title: "an unterminated stream is reported",
    rank: "should",
    scenario: "no-terminal-frame",
    run: async ({ page }) => {
      await sendPrompt(page, PROMPT);
      await waitForTurnEnded(page, 25_000);
      const turn = await readTurn(page);
      const conversation = await readConversation(page);
      const kinds = (await readTranscript(page)).map((entry) => entry.kind);
      const thread = await readThread(page);

      assertSame(
        turn.turnState,
        "the turn stream ended without a terminal frame",
        "the turn state after the stream closed",
      );
      assertSame(turn.tools, 3, "tools retained after the stream closed");
      assertAtLeast(turn.assistantCharacters, 1, "partial assistant text retained");
      assert(
        !kinds.some((kind) => kind.startsWith("terminal")),
        `the page invented a terminal entry: ${kinds.join(", ")}`,
      );
      assertSame(turn.sendDisabled, false, "Send after the stream closed");
      assertSame(turn.cancelDisabled, true, "Cancel after the stream closed");
      assertSame(thread.turnActive, "no", "whether a turn still holds the project");
      assertNonEmpty(conversation.allText, "the retained transcript");

      return `the page reported the missing terminal frame and kept 3 tools and ${turn.assistantCharacters} assistant characters`;
    },
  },
  {
    id: "CHAT-7",
    title: "browser cancellation aborts and ignores late frames",
    rank: "should",
    scenario: "ready-paused",
    run: async ({ page, server }) => {
      await sendPrompt(page, PROMPT);
      await server.waitForBarrier();
      await sleep(FRAME_INTERVAL_MS);
      const held = await readTurn(page);
      assertAtLeast(held.assistantCharacters, 1, "partial assistant text before cancelling");

      await page.click(byId(ID.cancelTurnButton));
      await server.waitForResponseClosed();
      await waitForTurnEnded(page);
      server.release();
      await sleep(FRAME_INTERVAL_MS * 2);

      const turn = await readTurn(page);
      const diffs = await readDiffs(page);
      const kinds = (await readTranscript(page)).map((entry) => entry.kind);
      const thread = await readThread(page);
      assertSame(
        turn.turnState,
        "cancelled: this browser stopped the turn",
        "the turn state after Cancel",
      );
      assertSame(turn.tools, held.tools, "tool blocks after the release of held frames");
      assertSame(diffs.diffMessages, 0, "turn diff entries after cancelling");
      assert(
        !kinds.some((kind) => kind.startsWith("terminal")),
        `a terminal entry arrived after cancelling: ${kinds.join(", ")}`,
      );
      assertSame(turn.sendDisabled, false, "Send after cancelling");
      assertSame(turn.cancelDisabled, true, "Cancel after cancelling");
      assertSame(thread.pageError, "", "the page error banner after cancelling");
      assertSame(thread.revision, "3", "the thread revision after cancelling");
      assertSame(thread.messageCount, "2", "the stored message count after cancelling");
      assertSame(
        server.thread(HARNESS_PROJECT_ID).revision,
        3,
        "the stored revision after cancelling",
      );
      assertSame((await readGeneration(page)).lastRead, "ok", "the last status read");

      return `Cancel closed the response, kept ${turn.tools} tool block(s), and the thread stayed at revision 3 with 2 messages after the held frames were released`;
    },
  },
];
