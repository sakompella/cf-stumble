import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { expect, requestsTo, test } from "./fixtures.mjs";

test("the generation panel follows an activation the agent made, without Refresh status", async ({
  owner,
  server,
}) => {
  const label = owner.locator(`#${ID.activeGenerationLabel}`);

  await expect(label).toHaveText("1");

  server.activateGeneration(2);

  await expect(label).toHaveText("2");
  await expect(owner.locator(`#${ID.activeGenerationCommit}`)).toHaveText("commit-2");
  await expect(owner.locator(`#${ID.generationEpoch}`)).toHaveText("4");
  await expect(owner.locator(`#${ID.conversationState}`)).toHaveText("live");
  expect(requestsTo(server, "GET", "/api/status")).toHaveLength(2);
});
