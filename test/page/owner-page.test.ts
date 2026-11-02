import { expect, test } from "vitest";
import { ownerPageHtml, OWNER_PAGE_SCRIPT_FILE } from "../../src/page/index.js";
import { OWNER_PAGE_IDS } from "../../src/page/element-ids.js";

test("the document is a container for the program and one same-origin script, and nothing else can run or style the page", () => {
  const html = ownerPageHtml("test-nonce");

  expect(html).toContain(`<main id="${OWNER_PAGE_IDS.root}"></main>`);
  expect(html).toContain('<style nonce="test-nonce">');
  expect(html.match(/<script\b[^>]*>/gu)).toEqual([
    `<script src="${OWNER_PAGE_SCRIPT_FILE.path}">`,
  ]);
  expect(html).not.toMatch(/\son[a-z]+=/u);
  expect(html).not.toMatch(/<(?:link|img|iframe)\b/u);
});

test("the script's path names a hash of its bytes", async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(OWNER_PAGE_SCRIPT_FILE.source),
  );

  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));

  expect(OWNER_PAGE_SCRIPT_FILE.path).toBe(`/assets/owner-${hex.join("").slice(0, 16)}.js`);
});
