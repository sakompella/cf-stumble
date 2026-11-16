import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { expect, requestsTo, test } from "./fixtures.mjs";

const DISCONNECT_PATH = "/api/chatgpt/disconnect";

test.describe("a connected ChatGPT login", () => {
  test.use({ scenario: "chatgpt-connected" });

  test("is dropped only after a second, explicit step", async ({ owner, server }) => {
    const connection = owner.locator(`#${ID.chatgptConnection}`);

    await expect(connection).toHaveText("connected (gpt-6.1-sol)");
    await owner.locator(`#${ID.chatgptDisconnectButton}`).click();

    await expect(owner.getByRole("alert")).toContainText("Sign out of ChatGPT?");
    expect(requestsTo(server, "POST", DISCONNECT_PATH)).toEqual([]);

    await owner.locator(`#${ID.chatgptKeepButton}`).click();

    await expect(owner.locator(`#${ID.chatgptDisconnectButton}`)).toBeVisible();
    await expect(owner.getByRole("alert")).toHaveCount(0);
    expect(requestsTo(server, "POST", DISCONNECT_PATH)).toEqual([]);

    await owner.locator(`#${ID.chatgptDisconnectButton}`).click();
    await owner.locator(`#${ID.chatgptDisconnectConfirmButton}`).click();

    await expect(connection).toHaveText("not connected (Workers AI fallback)");
    expect(requestsTo(server, "POST", DISCONNECT_PATH)).toHaveLength(1);
  });

  test("has no button that a search for Connect would also find", async ({ owner }) => {
    await expect(owner.getByRole("button", { name: "Connect" })).toHaveCount(1);
    await expect(owner.locator(`#${ID.connectButton}`)).toHaveText("Connect");
  });
});
