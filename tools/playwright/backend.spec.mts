import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { expect, requestsTo, test } from "./fixtures.mjs";

test("choosing the other workspace container says what the switch did and where the next one starts", async ({
  owner,
  server,
}) => {
  const result = owner.locator(`#${ID.backendResult}`);
  const cloudflare = owner.getByRole("button", { name: "Cloudflare", exact: true });
  const provider = owner.getByRole("button", { name: "Provider", exact: true });

  await expect(provider).toHaveAttribute("aria-pressed", "true");
  await expect(result).toHaveText("");

  await cloudflare.click();

  await expect(cloudflare).toHaveAttribute("aria-pressed", "true");
  await expect(result).toHaveText("stopped the container; the next container starts on Cloudflare");

  await provider.click();

  await expect(provider).toHaveAttribute("aria-pressed", "true");
  await expect(result).toHaveText(
    "no container was running; no provider is connected, so the next container starts on Cloudflare",
  );

  await provider.click();

  await expect(result).toHaveText(
    "already selected, nothing changed; no provider is connected, so the next container starts on Cloudflare",
  );
  expect(requestsTo(server, "POST", "/api/workspace/backend").map((r) => r.body)).toEqual([
    { backend: "cloudflare" },
    { backend: "provider" },
    { backend: "provider" },
  ]);

  await owner.reload();

  await expect(owner.locator(`#${ID.backendResult}`)).toHaveText("");
  await expect(provider).toHaveAttribute("aria-pressed", "true");
});
