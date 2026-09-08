import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  assertAtLeast,
  assertIncludes,
  assertNonEmpty,
  assertSame,
  completeTurn,
  HARNESS_PROJECT_ID,
  MARKUP_IMAGE_TEXT,
  MARKUP_SCRIPT_TEXT,
  readConversation,
  readDiffs,
  readTools,
  readTranscript,
  readTurn,
  sendPrompt,
  waitForText,
  type HarnessCase,
} from "../harness.mjs";
import { REFUSALS, SAVED_STATE } from "./_chat.mjs";

/**
 * What a turn puts on the page, and what the page refuses to do with it.
 *
 * Everything a turn carries is untrusted: a repository file, a command's output, and the model's
 * own text all arrive as text and have to stay text. A refusal that arrives before any frame is
 * the same kind of claim from the other direction — the page has to translate it without erasing
 * the conversation it already had.
 */
export const CASES: readonly HarnessCase[] = [
  {
    id: "CHAT-8",
    title: "HTTP turn refusals use owner-facing wording",
    rank: "should",
    scenario: "turn-conflict",
    allowedRequestFailures: [`POST /api/projects/${HARNESS_PROJECT_ID}/turn`],
    run: async ({ page, reopen }) => {
      const observed: string[] = [];
      for (const refusal of REFUSALS) {
        await reopen(refusal.scenario);
        const saved = await readConversation(page);
        assertSame(
          saved.messages,
          2,
          `the saved conversation before a ${refusal.scenario} refusal`,
        );

        const prompt = `Refused by ${refusal.scenario}`;
        await sendPrompt(page, prompt);
        await waitForText(page, ID.turnState, refusal.state);

        const turn = await readTurn(page);
        const conversation = await readConversation(page);
        const kinds = (await readTranscript(page)).map((entry) => entry.kind);
        assertSame(turn.turnState, refusal.state, `the ${refusal.scenario} turn state`);
        assertIncludes(conversation.allText, prompt, "the transcript after the refusal");
        assertIncludes(
          conversation.allText,
          HARNESS_PROJECT_ID,
          "the saved conversation after the refusal",
        );
        assertSame(turn.tools, 0, `tool blocks after a ${refusal.scenario} refusal`);
        assert(
          !kinds.some((kind) => kind.startsWith("terminal")),
          `the page fabricated a terminal entry for ${refusal.scenario}: ${kinds.join(", ")}`,
        );
        assertSame(turn.sendDisabled, false, `Send after a ${refusal.scenario} refusal`);
        observed.push(`${refusal.scenario} → "${turn.turnState}"`);
      }
      return `${observed.join("; ")}, each with the saved conversation and the typed prompt still visible`;
    },
  },
  {
    id: "CHAT-9",
    title: "diff-unavailable explains the missing patch",
    rank: "should",
    scenario: "diff-unavailable",
    run: async ({ page }) => {
      await completeTurn(page, "Change the turn route");
      const diffs = await readDiffs(page);
      const turn = await readTurn(page);

      assertSame(diffs.unavailableMessages, 1, "diff-unavailable entries");
      assertIncludes(
        diffs.unavailableText,
        "the workspace held no git repository",
        "the diff-unavailable explanation",
      );
      assertSame(diffs.diffMessages, 0, "turn diff entries");
      assertSame(diffs.diffAdded + diffs.diffRemoved + diffs.diffHunks, 0, "turn diff lines");
      assertSame(turn.turnState, SAVED_STATE, "the terminal turn state");

      return `one explanation replaced the turn diff and the turn still ended ${SAVED_STATE}`;
    },
  },
  {
    id: "CHAT-10",
    title: "a read-only turn needs no diff frame",
    rank: "should",
    scenario: "no-diff",
    run: async ({ page }) => {
      await completeTurn(page, "Summarize the README without changing files");
      const turn = await readTurn(page);
      const tools = await readTools(page);
      const diffs = await readDiffs(page);

      assertAtLeast(turn.assistantCharacters, 1, "assistant text in a read-only turn");
      assertSame(tools.length, 1, "tool disclosures in a read-only turn");
      assert(
        (tools[0]?.summary ?? "").endsWith("— done"),
        `the read tool summary: read "${tools[0]?.summary ?? ""}"`,
      );
      assertNonEmpty(tools[0]?.output ?? "", "the read tool output");
      assertSame(diffs.diffMessages, 0, "turn diff entries");
      assertSame(diffs.unavailableMessages, 0, "diff-unavailable entries");
      assertSame(turn.turnState, SAVED_STATE, "the terminal turn state");
      assertSame(turn.sendDisabled, false, "Send after a read-only turn");

      await completeTurn(page, "Say that again in one line");
      assertSame(
        (await readTurn(page)).turnState,
        SAVED_STATE,
        "the terminal state of the second turn",
      );

      return `the read-only turn ended ${SAVED_STATE} with one finished tool, no diff entry of either kind, and a second turn started normally`;
    },
  },
  {
    id: "CHAT-11",
    title: "repository and model output remains literal text",
    rank: "should",
    scenario: "markup-output",
    run: async ({ page }) => {
      await completeTurn(page, "Read the README");
      const conversation = await readConversation(page);

      assertSame(conversation.createdImages, 0, "img elements inside the transcript");
      assertSame(conversation.createdScripts, 0, "script elements inside the transcript");
      assertSame(conversation.title, "cf-stumble", "the document title after the turn");
      assertIncludes(conversation.allText, MARKUP_IMAGE_TEXT, "the tool result text");
      assertIncludes(conversation.allText, MARKUP_SCRIPT_TEXT, "the assistant text");

      return `the transcript quoted "${MARKUP_IMAGE_TEXT}" and "${MARKUP_SCRIPT_TEXT}" as text, created no element, and left the title cf-stumble`;
    },
  },
];
