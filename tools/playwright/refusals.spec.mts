import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { MAX_REPOSITORY_BLOB_COUNT } from "../../src/repository-limits.js";
import { MISTYPED_REPOSITORY_URL, TOO_LARGE_REPOSITORY_URL } from "../browser-harness/fixtures.mjs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.mjs";

async function connectTo(owner: Page, url: string): Promise<void> {
  await owner.getByLabel("repository url").fill(url);
  await owner.locator(`#${ID.connectButton}`).click();
}

test.describe("a refused connect", () => {
  test.use({ allowedConsoleErrors: [/status of (403|413)/u] });

  test("a mistyped repository is refused with a sentence about the name, not a code", async ({
    owner,
  }) => {
    await connectTo(owner, MISTYPED_REPOSITORY_URL);

    const status = owner.locator(`#${ID.connectStatus}`);

    await expect(status).toContainText("Check the name for a typo");
    await expect(status).not.toContainText("repository-not-accessible");
  });

  test("a repository that is too large is refused with the limits", async ({ owner }) => {
    await connectTo(owner, TOO_LARGE_REPOSITORY_URL);

    const status = owner.locator(`#${ID.connectStatus}`);

    await expect(status).toContainText(MAX_REPOSITORY_BLOB_COUNT.toLocaleString("en-US"));
    await expect(status).not.toContainText("repository-too-large");
  });
});

test("the chosen time budget and workspace container have a background the others lack", async ({
  owner,
}) => {
  const tint = /rgba\(90, 140, 220/u;
  const budget = owner.getByRole("group", { name: "time budget" });
  const chosen = budget.getByRole("button", { name: "30 min", exact: true });
  const provider = owner.getByRole("button", { name: "Provider", exact: true });

  await expect(chosen).toHaveAttribute("aria-pressed", "true");
  await expect(chosen).toHaveCSS("background-color", tint);
  await expect(budget.getByRole("button", { name: "8 min", exact: true })).not.toHaveCSS(
    "background-color",
    tint,
  );
  await expect(provider).toHaveAttribute("aria-pressed", "true");
  await expect(provider).toHaveCSS("background-color", tint);
  await expect(owner.getByRole("button", { name: "Cloudflare", exact: true })).not.toHaveCSS(
    "background-color",
    tint,
  );

  await budget.getByRole("button", { name: "8 min", exact: true }).click();

  await expect(budget.getByRole("button", { name: "8 min", exact: true })).toHaveCSS(
    "background-color",
    tint,
  );
  await expect(chosen).not.toHaveCSS("background-color", tint);
});
