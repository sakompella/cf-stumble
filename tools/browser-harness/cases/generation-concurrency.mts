import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assertRequestBody,
  assertSame,
  byId,
  readConversation,
  readGeneration,
  type BrowserPage,
  type HarnessCase,
  type HarnessServer,
} from "../harness.mjs";
import {
  CANDIDATE,
  generationRequests,
  openControls,
  prepareCandidate,
  waitForGeneration,
} from "./_generation.mjs";

async function makeStale(page: BrowserPage, server: HarnessServer): Promise<void> {
  await openControls(page);
  await prepareCandidate(page);
  server.setGeneration({ epoch: 4 });
  server.clearRequests();
  await page.type(byId(ID.activateLabelInput), String(CANDIDATE.label));
  await page.click(byId(ID.activateButton));
  await page.waitFor(
    `document.getElementById(${JSON.stringify(ID.activateStatus)})?.textContent === "rejected: stale-epoch"`,
  );
  await waitForGeneration(page, "1", "4");
}

export const CASES: readonly HarnessCase[] = [
  {
    id: "GEN-5",
    title: "stale activation refreshes automatically",
    rank: "should",
    scenario: "ready",
    allowedRequestFailures: ["POST /api/generations/activate"],
    run: async ({ page, server }) => {
      await makeStale(page, server);
      const snapshot = await readGeneration(page);
      const activations = generationRequests(server, "/api/generations/activate");
      assertSame(activations.length, 1, "stale activation requests");
      assertRequestBody(activations[0], { observedEpoch: 3, label: 2 }, "stale activation");
      assertSame(snapshot.activateStatus, "rejected: stale-epoch", "the stale activation result");
      assertSame(snapshot.activateEffect, "", "the stale activation effect");
      assertSame(snapshot.activateSentEpoch, "3", "the stale activation sent epoch");
      assertSame(snapshot.activeLabel, "1", "the active label after stale activation");
      assertSame(snapshot.activeCommit, "abc123", "the active commit after stale activation");
      assertSame(snapshot.epoch, "4", "the automatically refreshed epoch");

      return "the page sent displayed epoch 3, reported stale-epoch, and automatically refreshed unchanged generation 1 to epoch 4";
    },
  },
  {
    id: "GEN-6",
    title: "manual refresh recovers after stale rejection",
    rank: "should",
    scenario: "ready",
    allowedRequestFailures: ["POST /api/generations/activate"],
    run: async ({ page, server }) => {
      await makeStale(page, server);
      const before = await readGeneration(page);
      await page.click(byId(ID.refreshStatusButton));
      await waitForGeneration(page, "1", "4");
      const refreshed = await readGeneration(page);
      const activations = generationRequests(server, "/api/generations/activate");
      assertSame(refreshed.activateStatus, "rejected: stale-epoch", "the retained stale result");
      assertSame(refreshed.activateEffect, "", "the retained stale effect");
      assertSame(refreshed.activateSentEpoch, "3", "the retained sent epoch");
      assertSame(
        refreshed.activeLabel,
        before.activeLabel,
        "the active label after manual refresh",
      );
      assertSame(refreshed.activeCommit, "abc123", "the active commit after manual refresh");
      assertSame(activations.length, 1, "activation requests after manual refresh");
      assertRequestBody(
        activations[0],
        { observedEpoch: 3, label: 2 },
        "manual-refresh activation",
      );

      return `stale activation stayed rejected with sent epoch 3; manual refresh kept generation 1 and exposed epoch ${refreshed.epoch}`;
    },
  },
  {
    id: "GEN-8",
    title: "repeated commands are harmless",
    rank: "should",
    scenario: "ready",
    run: async ({ page, server }) => {
      const before = await readConversation(page);
      await openControls(page);
      server.clearRequests();
      await page.type(byId(ID.candidateCommitInput), "abc123");
      await page.click(byId(ID.submitCandidateButton));
      await page.waitFor(
        `document.getElementById(${JSON.stringify(ID.submitStatus)})?.textContent === "ok"`,
      );
      const submitted = await readGeneration(page);
      assertSame(submitted.submitLabel, "1", "the existing generation label");
      assertSame(
        server.generation().generations.length,
        1,
        "generation records after repeat submission",
      );
      await page.type(byId(ID.activateLabelInput), "1");
      await page.click(byId(ID.activateButton));
      await page.waitFor(
        `document.getElementById(${JSON.stringify(ID.activateStatus)})?.textContent === "ok"`,
      );
      const snapshot = await readGeneration(page);
      const after = await readConversation(page);
      const activations = generationRequests(server, "/api/generations/activate");
      assertSame(snapshot.activateEffect, "no-change", "the repeated activation effect");
      assertSame(snapshot.activeLabel, "1", "the active label after repeated commands");
      assertSame(snapshot.epoch, "3", "the epoch after repeated commands");
      assertSame(activations.length, 1, "repeated activation requests");
      assertRequestBody(activations[0], { observedEpoch: 3, label: 1 }, "repeated activation");
      assertSame(after.allText, before.allText, "the transcript after repeated commands");

      return "repeated abc123 submission returned existing generation 1, activation was a no-change at epoch 3, and the transcript stayed unchanged";
    },
  },
];
