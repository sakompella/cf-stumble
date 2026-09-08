import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assertRequestBody,
  assertSame,
  byId,
  HARNESS_PROJECT_ID,
  readConversation,
  readGeneration,
  readThread,
  sleep,
  waitForText,
  completeTurn,
  readTurn,
  assertIncludes,
  type BrowserPage,
  type HarnessCase,
  type HarnessServer,
} from "../harness.mjs";
import { CANDIDATE, generationRequests, openControls, waitForGeneration } from "./_generation.mjs";

async function restoreEarlier(page: BrowserPage, server: HarnessServer) {
  server.setGeneration({
    generations: [{ label: 1, harnessCommit: "abc123", status: "ready" }, CANDIDATE],
    activeLabel: 2,
    epoch: 4,
  });
  await page.click(byId(ID.refreshStatusButton));
  await waitForGeneration(page, "2", "4");
  const before = await readThread(page);
  const transcript = await readConversation(page);
  await openControls(page);
  server.clearRequests();
  await page.type(byId(ID.rollbackLabelInput), "1");
  await page.click(byId(ID.rollbackButton));
  await waitForText(page, ID.rollbackStatus, "ok");
  await waitForGeneration(page, "1", "5");
  const rolled = await readGeneration(page);
  const rollbacks = generationRequests(server, "/api/generations/rollback");
  assertSame(rollbacks.length, 1, "rollback requests");
  assertRequestBody(rollbacks[0], { observedEpoch: 4, label: 1 }, "rollback");
  assertSame(rolled.rollbackSentEpoch, "4", "the sent rollback epoch");
  assertSame(rolled.rollbackEffect, "rolled-back", "the rollback effect");
  assertSame(
    generationRequests(server, "/api/generations/activate").length,
    0,
    "activation requests during rollback",
  );
  return { before, transcript };
}

async function finishRollback(
  page: BrowserPage,
  evidence: Awaited<ReturnType<typeof restoreEarlier>>,
): Promise<string> {
  await page.reload();
  await waitForGeneration(page, "1", "5");
  const reloaded = await readThread(page);
  const retained = await readConversation(page);
  assertSame(reloaded.project, evidence.before.project, "the project after rollback and reload");
  assertSame(reloaded.revision, evidence.before.revision, "the revision after rollback and reload");
  assertIncludes(
    retained.allText,
    evidence.transcript.firstText,
    "the conversation after rollback and reload",
  );
  assertSame((await readGeneration(page)).activateStatus, "", "activation result after reload");
  await completeTurn(page, "Report the retained edit");
  assertSame(
    (await readTurn(page)).turnState,
    "saved · revision 4 · 6 messages",
    "the continuation after rollback",
  );
  assertIncludes(
    (await readConversation(page)).allText,
    "EARLIER-EDIT-KEPT",
    "the retained edit marker",
  );
  return `rollback sent epoch 4 to label 1, preserved ${HARNESS_PROJECT_ID} revision 3 and its conversation across reload, then saved a continuation with EARLIER-EDIT-KEPT`;
}

async function rejectLabel(page: BrowserPage, server: HarnessServer, value: string): Promise<void> {
  server.clearRequests();
  await page.type(byId(ID.activateLabelInput), value);
  await page.click(byId(ID.activateButton));
  await sleep(150);
  assertSame(
    (await readGeneration(page)).activateStatus,
    "enter a generation label",
    `activation validation for ${value || "empty"} label`,
  );
  assertSame(
    generationRequests(server, "/api/generations/activate").length,
    0,
    `activation requests for ${value || "empty"} label`,
  );
  await page.type(byId(ID.rollbackLabelInput), value);
  await page.click(byId(ID.rollbackButton));
  await sleep(150);
  assertSame(
    (await readGeneration(page)).rollbackStatus,
    "enter a generation label",
    `rollback validation for ${value || "empty"} label`,
  );
  assertSame(
    generationRequests(server, "/api/generations/rollback").length,
    0,
    `rollback requests for ${value || "empty"} label`,
  );
}

async function rejectWithoutEpoch(page: BrowserPage, server: HarnessServer): Promise<void> {
  await page.type(byId(ID.activateLabelInput), "2");
  await page.click(byId(ID.activateButton));
  await waitForText(page, ID.activateStatus, "refresh the status first");
  assertSame(
    generationRequests(server, "/api/generations/activate").length,
    0,
    "activation requests without an epoch",
  );
  assertSame((await readGeneration(page)).activeLabel, "", "active label without a status epoch");
}

export const CASES: readonly HarnessCase[] = [
  {
    id: "GEN-7",
    title: "rollback restores the earlier generation without losing edit evidence",
    rank: "must",
    scenario: "ready",
    run: async ({ page, server }) => {
      const evidence = await restoreEarlier(page, server);
      return finishRollback(page, evidence);
    },
  },
  {
    id: "GEN-9",
    title: "invalid or missing control input sends nothing",
    rank: "should",
    scenario: "ready",
    allowedRequestFailures: ["GET /api/status"],
    run: async ({ page, server, reopen }) => {
      await openControls(page);
      server.clearRequests();
      await page.click(byId(ID.submitCandidateButton));
      await waitForText(page, ID.submitStatus, "enter a harness commit first");
      assertSame(
        generationRequests(server, "/api/generations/submit").length,
        0,
        "empty submission requests",
      );
      for (const value of ["", "-1", "1.5"]) {
        await rejectLabel(page, server, value);
      }
      await reopen("status-problem");
      await openControls(page);
      server.clearRequests();
      await rejectWithoutEpoch(page, server);
      return "empty, negative, and fractional labels were rejected locally, and missing status epoch was rejected without a generation POST";
    },
  },
];
