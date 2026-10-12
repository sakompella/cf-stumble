/**
 * The document the browser receives and the script file it names.
 *
 * These tests read text. What the Foldkit program in `src/page/client` renders and how it behaves
 * is tested against its update function and views in `test/page/client/`, and in a real browser by
 * `tools/browser-harness/`.
 */

import { expect, test } from "vitest";
import { ownerPageHtml, OWNER_PAGE_IDS, OWNER_PAGE_SCRIPT_FILE } from "../../src/page/index.js";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

/** The program's own source. The bundle also holds Foldkit and Effect, whose text is not ours. */
const clientSources = import.meta.glob("../../src/page/client/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

test("the document is a container for the program and one same-origin script", () => {
  const html = ownerPageHtml("test-nonce");

  expect(html).toContain(`<main id="${OWNER_PAGE_IDS.root}"></main>`);
  expect(html).toContain('<style nonce="test-nonce">');
  expect(html.match(/<script\b[^>]*>/gu)).toEqual([
    `<script src="${OWNER_PAGE_SCRIPT_FILE.path}">`,
  ]);
});

test("the script's path names a hash of its bytes", async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(OWNER_PAGE_SCRIPT_FILE.source),
  );

  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));

  // The Worker lets a browser keep the script for a year, which is safe only while one path always
  // means the same bytes.
  expect(OWNER_PAGE_SCRIPT_FILE.path).toBe(`/assets/owner-${hex.join("").slice(0, 16)}.js`);
});

test("the script the browser receives parses as JavaScript", () => {
  // A syntax error would leave the empty container on screen and nothing else. Parsing the
  // delivered script is the check that the page can fill itself in at all.
  const script = OWNER_PAGE_SCRIPT_FILE.source;

  expect(script.length).toBeGreaterThan(0);
  // oxlint-disable-next-line typescript/no-implied-eval -- Constructing the function is the check. It parses the script and is never called.
  expect(() => new Function(script)).not.toThrow();
});

test("nothing outside the nonced style and the script file can run or style the page", () => {
  const html = ownerPageHtml("test-nonce");

  // The Content Security Policy refuses inline handlers and any other origin, so the document
  // carries neither.
  expect(html).not.toMatch(/\son[a-z]+=/u);
  expect(html).not.toMatch(/<(?:link|img|iframe)\b/u);
});

test("the program never writes markup, evaluates code, or stores anything", () => {
  const files = Object.entries(clientSources);

  expect(files.length).toBeGreaterThan(0);

  // Everything a turn shows came from a repository or a model, so it reaches the document only as
  // view text. The page asks for no credential and keeps none.
  for (const [path, source] of files) {
    expect(source, path).not.toMatch(
      /InnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|localStorage|sessionStorage|indexedDB|document\.cookie|CF_Authorization/u,
    );
  }
});

test("the program calls only this origin", () => {
  for (const [path, source] of Object.entries(clientSources)) {
    // Every request is a relative path, so the policy's `connect-src 'self'` is never tested by a
    // request the page meant to make. The GitHub verification link is data from the Worker.
    expect(source, path).not.toMatch(/["'`]https?:\/\//u);
  }
});
