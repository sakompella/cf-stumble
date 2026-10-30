import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { expect, requestsTo, test } from "./fixtures.mjs";

test("a candidate is submitted, activated at the shown epoch, then rolled back", async ({
  owner,
  server,
}) => {
  const activeLabel = owner.locator(`#${ID.activeGenerationLabel}`);
  const epoch = owner.locator(`#${ID.generationEpoch}`);
  await owner.getByText("Generation controls").click();

  await owner.getByLabel("harness commit").fill("def456");
  await owner.locator(`#${ID.submitCandidateButton}`).click();
  await expect(owner.locator(`#${ID.submitStatus}`)).toHaveText("ok");
  await expect(owner.locator(`#${ID.submitGenerationLabel}`)).toHaveText("2");
  await expect(activeLabel).toHaveText("1");
  expect(requestsTo(server, "POST", "/api/generations/submit").map((r) => r.body)).toEqual([
    { harnessCommit: "def456" },
  ]);

  await owner.locator(`#${ID.activateLabelInput}`).fill("2");
  await owner.locator(`#${ID.activateButton}`).click();
  await expect(owner.locator(`#${ID.activateStatus}`)).toHaveText("ok");
  await expect(activeLabel).toHaveText("2");
  await expect(epoch).toHaveText("4");
  expect(requestsTo(server, "POST", "/api/generations/activate").map((r) => r.body)).toEqual([
    { observedEpoch: 3, label: 2 },
  ]);

  await owner.locator(`#${ID.rollbackLabelInput}`).fill("1");
  await owner.locator(`#${ID.rollbackButton}`).click();
  await expect(owner.locator(`#${ID.rollbackStatus}`)).toHaveText("ok");
  await expect(activeLabel).toHaveText("1");
  await expect(owner.locator(`#${ID.rollbackEffect}`)).toHaveText("rolled-back");
  expect(requestsTo(server, "POST", "/api/generations/rollback").map((r) => r.body)).toEqual([
    { observedEpoch: 4, label: 1 },
  ]);
});
