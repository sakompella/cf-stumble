import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assertAtLeast,
  assertIncludes,
  assertNonEmpty,
  assertRequestBody,
  assertSame,
  byId,
  completeTurn,
  HARNESS_PROJECT_ID,
  readConversation,
  readGeneration,
  readThread,
  readTurn,
  selectRequests,
  sendPrompt,
  waitForText,
  waitForTurnEnded,
  type HarnessCase,
} from "../harness.mjs";
import {
  CANDIDATE,
  generationRequests,
  openControls,
  prepareCandidate,
  submitCommit,
  waitForGeneration,
} from "./_generation.mjs";

export const CASES: readonly HarnessCase[] = [
  {
    id: "GEN-2",
    title: "passing submission labels but does not activate",
    rank: "must",
    scenario: "ready",
    run: async ({ page, server }) => {
      await openControls(page);
      server.clearRequests();
      await submitCommit(page, CANDIDATE.harnessCommit);
      const snapshot = await readGeneration(page);
      const submissions = generationRequests(server, "/api/generations/submit");
      const statuses = selectRequests(server.requests(), "GET", "/api/status");
      assertSame(snapshot.submitStatus, "ok", "the candidate submission result");
      assertSame(snapshot.submitLabel, "2", "the labeled generation");
      assertSame(snapshot.submitEpoch, "3", "the labeling epoch");
      assertSame(
        snapshot.submitPreparation,
        "ready: startup check answered",
        "the preparation result",
      );
      assertSame(submissions.length, 1, "candidate submission requests");
      assertRequestBody(
        submissions[0],
        { harnessCommit: CANDIDATE.harnessCommit },
        "candidate submission",
      );
      assertAtLeast(statuses.length, 1, "status reads after candidate submission");
      assertSame(snapshot.activeLabel, "1", "the active generation after submission");
      assertSame(snapshot.activeCommit, "abc123", "the active commit after submission");
      assertSame(snapshot.activeStatus, "ready", "the active status after submission");
      assertSame(snapshot.epoch, "3", "the active epoch after submission");

      return `submitted ${CANDIDATE.harnessCommit} as generation 2 at epoch 3 with one exact POST; active generation 1 remained abc123 ready`;
    },
  },
  {
    id: "GEN-3",
    title: "failed candidate leaves the active generation serving",
    rank: "must",
    scenario: "ready-paused",
    run: async ({ page, server }) => {
      await openControls(page);
      await submitCommit(page, "broken456");
      const failed = await readGeneration(page);
      assertSame(
        failed.submitPreparation,
        "rejected: startup-check-failed",
        "the failed startup check",
      );
      assertSame(failed.activeLabel, "1", "the active label after a failed candidate");
      assertSame(failed.activeCommit, "abc123", "the active commit after a failed candidate");
      assertSame(failed.epoch, "3", "the epoch after a failed candidate");
      await page.click(`${byId(ID.generationDrawer)} summary`);

      await sendPrompt(page, "Continue after the failed candidate");
      await server.waitForBarrier();
      const held = await readTurn(page);
      assertSame(held.turnState, "running", "the turn state after a failed candidate");
      assertAtLeast(
        held.assistantCharacters,
        1,
        "assistant text streamed after a failed candidate",
      );
      server.release();
      await waitForTurnEnded(page);
      const finished = await readTurn(page);
      await waitForText(page, ID.threadRevision, "4");
      const thread = await readThread(page);
      assertSame(
        finished.turnState,
        "saved · revision 4 · 6 messages",
        "the turn after a failed candidate",
      );
      assertSame(thread.pageError, "", "the page error after a failed candidate");
      assertSame(thread.revision, "4", "the thread revision after the continuation");
      assertSame(
        server.generation().activeLabel,
        1,
        "the server's active generation after failure",
      );

      return `broken456 reported startup-check-failed while generation 1 kept serving; ${held.assistantCharacters} assistant characters streamed and the continuation saved at revision 4`;
    },
  },
  {
    id: "GEN-4",
    title: "activation sends the shown epoch and preserves conversation",
    rank: "must",
    scenario: "ready",
    run: async ({ page, server }) => {
      const before = await readConversation(page);
      const project = await readThread(page);
      await openControls(page);
      await prepareCandidate(page);
      server.clearRequests();
      await page.type(byId(ID.activateLabelInput), "2");
      await page.click(byId(ID.activateButton));
      await waitForText(page, ID.activateStatus, "ok");
      await waitForGeneration(page, "2", "4");
      const afterActivation = await readGeneration(page);
      const activations = generationRequests(server, "/api/generations/activate");
      assertSame(activations.length, 1, "activation requests");
      assertRequestBody(activations[0], { observedEpoch: 3, label: 2 }, "activation");
      assertSame(afterActivation.activateSentEpoch, "3", "the sent activation epoch");
      assertSame(afterActivation.activateEffect, "activated", "the activation effect");
      assertSame(afterActivation.activeCommit, CANDIDATE.harnessCommit, "the activated commit");
      assertSame(afterActivation.activeStatus, "ready", "the activated status");
      const kept = await readThread(page);
      assertSame(kept.project, project.project, "the selected project after activation");
      assertIncludes(
        (await readConversation(page)).allText,
        before.firstText,
        "conversation after activation",
      );

      await completeTurn(page, "Continue the same conversation");
      const finished = await readTurn(page);
      assertSame(
        finished.turnState,
        "saved · revision 4 · 6 messages",
        "the continuation after activation",
      );
      assertNonEmpty((await readConversation(page)).allText, "the continued conversation");

      return `activation sent epoch 3 exactly, moved to generation 2 at epoch 4, preserved ${HARNESS_PROJECT_ID}, and the continuation saved at revision 4`;
    },
  },
];
