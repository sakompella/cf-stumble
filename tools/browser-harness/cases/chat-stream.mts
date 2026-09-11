import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  assertAtLeast,
  assertIncludes,
  assertNonDecreasing,
  assertNonEmpty,
  assertSame,
  completeTurn,
  HARNESS_PROJECT_ID,
  openTool,
  readConversation,
  readDiffs,
  readThread,
  readTools,
  readTranscript,
  readTurn,
  sampleWhile,
  sendPrompt,
  sleep,
  waitForSettledReads,
  waitForText,
  waitForThreadOk,
  waitForTurnEnded,
  FRAME_INTERVAL_MS,
  type HarnessCase,
} from "../harness.mjs";
import { assertToolsDone, PROMPT, SAVED_STATE } from "./_chat.mjs";

/**
 * The streamed turn: what a reader sees while the model works, and what the page is allowed to
 * call a success.
 *
 * A turn has to be visible before its body ends, so CHAT-2 asserts at the stub's barrier rather
 * than at the end: a page that buffered the whole response fails there instead of passing later.
 * And `saved` is the Supervisor's own statement, never an HTTP status, so CHAT-4 follows it into a
 * stored thread and a new document (ADR-0037).
 */
export const CASES: readonly HarnessCase[] = [
  {
    id: "CHAT-1",
    title: "saved conversation loads for the selected project",
    rank: "must",
    scenario: "ready",
    run: async ({ page }) => {
      await waitForThreadOk(page);
      const thread = await readThread(page);
      const transcript = await readTranscript(page);
      const text = transcript.map((entry) => entry.text).join("\n");

      assertSame(thread.project, "hello-world", "the conversation heading");
      assertSame(thread.state, "ok", "the thread state");
      assertSame(thread.revision, "3", "the thread revision");
      assertSame(thread.turnActive, "no", "whether a turn holds the project");
      assertSame(thread.messageCount, "2", "the stored message count");
      assertSame(transcript.length, 2, "the number of transcript entries");
      assertSame(transcript[0]?.kind ?? "", "user", "the first transcript entry");
      assertSame(transcript[1]?.kind ?? "", "assistant", "the second transcript entry");
      assertIncludes(text, HARNESS_PROJECT_ID, "the loaded conversation");

      return `hello-world loaded at revision 3 with 2 stored messages naming ${HARNESS_PROJECT_ID}`;
    },
  },
  {
    id: "CHAT-2",
    title: "text and tools appear before the stream closes",
    rank: "must",
    scenario: "ready-paused",
    run: async ({ page, server }) => {
      await sendPrompt(page, PROMPT);
      await server.waitForBarrier();
      await sleep(FRAME_INTERVAL_MS);

      const held = await readTurn(page);
      const heldTranscript = await readConversation(page);
      assertSame(held.turnState, "running", "the turn state at the barrier");
      assertSame(held.sendDisabled, true, "Send while the turn runs");
      assertSame(held.cancelDisabled, false, "Cancel while the turn runs");
      assertAtLeast(held.assistantCharacters, 1, "assistant characters at the barrier");
      assertAtLeast(held.tools, 1, "tool blocks at the barrier");
      assertAtLeast(held.finishedTools, 1, "finished tools at the barrier");
      assertIncludes(heldTranscript.allText, PROMPT, "the transcript at the barrier");

      server.release();

      const samples = await sampleWhile(
        () => readTurn(page),
        (sample) => sample.turnState === "running",
        100,
      );

      const running = samples.filter((sample) => sample.turnState === "running");
      assertAtLeast(running.length, 3, "samples taken while the turn was running");
      assertNonDecreasing(
        running.map((sample) => sample.assistantCharacters),
        "streamed assistant characters",
      );
      assertNonDecreasing(
        running.map((sample) => sample.tools),
        "streamed tool blocks",
      );

      await waitForTurnEnded(page);
      const transcript = await readTranscript(page);
      const kinds = transcript.map((entry) => entry.kind);
      const terminalAt = kinds.indexOf("terminal");
      const assistantBefore = kinds.slice(0, terminalAt).filter((kind) => kind === "assistant");
      const finished = await readTurn(page);
      assertSame(finished.tools, 3, "tool blocks when the turn ended");
      assertSame(finished.turnState, SAVED_STATE, "the terminal turn state");
      assertAtLeast(assistantBefore.length, 2, "assistant blocks rendered before success");

      return `${held.tools} tool(s) and ${held.assistantCharacters} assistant characters were visible at the barrier; ${running.length} running samples never decreased and the turn finished with 3 tools`;
    },
  },
  {
    id: "CHAT-3",
    title: "coding output is ordered and the turn diff is distinct",
    rank: "must",
    scenario: "ready",
    run: async ({ page }) => {
      await sendPrompt(page, PROMPT);

      const progress = await sampleWhile(
        () => readTools(page),
        (tools) => tools.length < 3 || tools.some((tool) => tool.output === "running…"),
        50,
      );

      assert(
        progress.some((tools) => tools.some((tool) => tool.output === "running…")),
        "no sample caught a tool while it was still running, so the page may render tools only when they finish",
      );

      await waitForTurnEnded(page);

      for (const index of [0, 1, 2]) {
        await openTool(page, index);
      }

      const tools = await readTools(page);
      const diffs = await readDiffs(page);
      const kinds = (await readTranscript(page)).map((entry) => entry.kind);

      assertSame(tools.length, 3, "tool disclosures");
      assertToolsDone(tools);
      assertNonEmpty(tools[2]?.output ?? "", "the opened command output");
      assertSame(diffs.diffMessages, 1, "turn diff entries");
      assertIncludes(diffs.diffText, "src/routes/turns.ts", "the turn diff");
      assertIncludes(diffs.diffText, "parseProjectId", "the turn diff");
      assert(
        !diffs.diffText.includes("markup.ts"),
        `the turn diff repeated the tool's patch: ${diffs.diffText.slice(0, 200)}`,
      );
      assertSame(diffs.diffAdded, 3, "added lines in the turn diff");
      assertSame(diffs.diffRemoved, 2, "removed lines in the turn diff");
      assertSame(diffs.diffHunks, 3, "hunk lines in the turn diff");
      assertSame(diffs.toolAdded, 3, "added lines in the tool patch");
      assertSame(diffs.toolRemoved, 1, "removed lines in the tool patch");
      assertSame(diffs.toolHunks, 3, "hunk lines in the tool patch");
      assert(
        kinds.indexOf("diff") < kinds.indexOf("terminal"),
        `the page reported success before the turn diff: ${kinds.join(", ")}`,
      );

      return `three tools finished, the turn diff (3 added, 2 removed, 3 hunks) named src/routes/turns.ts, and it preceded the terminal entry`;
    },
  },
  {
    id: "CHAT-4",
    title: "saved success is durable after refresh and reload",
    rank: "must",
    scenario: "ready",
    run: async ({ page, server }) => {
      await completeTurn(page, PROMPT);
      const streamed = await readTurn(page);
      const entries = await readTranscript(page);
      assertSame(streamed.turnState, SAVED_STATE, "the terminal turn state");
      assertSame(entries.at(-1)?.kind ?? "", "terminal", "the final transcript entry");
      assertIncludes(entries.at(-1)?.text ?? "", SAVED_STATE, "the final transcript entry");
      assertSame(streamed.tools, 3, "tools held by the streamed view");

      await waitForText(page, ID.threadRevision, "4");
      const requests = server.requests();

      const turnAt = requests.findLastIndex(
        (request) => request.method === "POST" && request.path.endsWith("/turn"),
      );

      const rereadAt = requests.findIndex(
        (request, index) =>
          index > turnAt && request.method === "GET" && request.path.endsWith("/thread"),
      );

      assertAtLeast(rereadAt, turnAt + 1, "a thread read following the turn POST");

      const beforeReload = await readThread(page);
      assertSame(beforeReload.revision, "4", "the thread revision after the quiet reread");
      assertSame(beforeReload.messageCount, "6", "the message count after the quiet reread");
      assertAtLeast((await readTranscript(page)).length, 1, "transcript entries after the reread");

      await page.reload();
      await waitForSettledReads(page);
      await waitForThreadOk(page);
      const reloaded = await readThread(page);
      const saved = await readConversation(page);
      assertSame(reloaded.project, "hello-world", "the project after reload");
      assertSame(reloaded.revision, "4", "the thread revision after reload");
      assertSame(reloaded.messageCount, "6", "the message count after reload");
      assertSame(saved.messages, 6, "rendered saved messages after reload");
      assertNonEmpty(saved.allText, "the saved conversation after reload");

      return `the turn reported ${SAVED_STATE}, re-read its thread after the POST, and revision 4 with 6 messages survived a full reload`;
    },
  },
];
