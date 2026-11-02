import { expect, test } from "vitest";
import { OWNER_PAGE_SCRIPT_FILE } from "../../src/page/index.js";

test("the script's path names a hash of its bytes", async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(OWNER_PAGE_SCRIPT_FILE.source),
  );

  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));

  expect(OWNER_PAGE_SCRIPT_FILE.path).toBe(`/assets/owner-${hex.join("").slice(0, 16)}.js`);
});
