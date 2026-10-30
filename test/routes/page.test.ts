/**
 * The owner page is one plain HTML document and one script file. These tests hold the properties
 * the rest of version 0 depends on: a browser gets the page and its script, and a machine keeps
 * the relayed `GET /` the startup check uses.
 *
 * What the page itself contains is tested in `test/page/owner-page.test.ts`. This file is about
 * the request boundary, so it stays readable as one thing.
 */

import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS, OWNER_PAGE_SCRIPT_FILE } from "../../src/page/index.js";
import { isOwnerPageRequest, ownerPageResponse } from "../../src/routes/index.js";
import worker from "../../src/worker.js";

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

function pageRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://cf-stumble.test/", { headers });
}

/** The owner page or its script, as a request with this `accept` header receives it. */
function pageFetch(path: string, accept: string): Promise<Response> {
  return worker.fetch(new Request(`https://cf-stumble.test${path}`, { headers: { accept } }), env);
}

test("a browser request for GET / receives the owner page", async () => {
  const response = await worker.fetch(pageRequest({ accept: BROWSER_ACCEPT }), env);
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body).toContain("<!doctype html>");
  expect(body).toContain(`id="${OWNER_PAGE_IDS.root}"`);
});

test("a machine request for GET / is not the owner page", () => {
  expect(ownerPageResponse(pageRequest({ accept: "*/*" }))).toBeUndefined();
  expect(ownerPageResponse(pageRequest({ accept: "application/json" }))).toBeUndefined();
  expect(ownerPageResponse(pageRequest())).toBeUndefined();
  expect(isOwnerPageRequest(pageRequest({ accept: BROWSER_ACCEPT }))).toBe(true);
});

test("only GET / is the owner page", () => {
  const posted = new Request("https://cf-stumble.test/", {
    method: "POST",
    headers: { accept: BROWSER_ACCEPT },
  });

  const other = new Request("https://cf-stumble.test/api/status", {
    headers: { accept: BROWSER_ACCEPT },
  });

  expect(ownerPageResponse(posted)).toBeUndefined();
  expect(ownerPageResponse(other)).toBeUndefined();
});

test("the page policy admits its own style and its same-origin script, and no inline code", async () => {
  const response = await pageFetch("/", BROWSER_ACCEPT);
  const policy = response.headers.get("content-security-policy") ?? "";
  const nonce = /style-src 'nonce-([^']+)'/u.exec(policy)?.[1];
  const body = await response.text();

  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("connect-src 'self'");
  expect(policy).toContain("script-src 'self';");
  expect(policy).not.toContain("unsafe-inline");
  expect(policy).not.toContain("unsafe-eval");
  expect(nonce).toBeDefined();
  expect(body).toContain(`<style nonce="${nonce ?? ""}">`);
  expect(body).toContain(`<script src="${OWNER_PAGE_SCRIPT_FILE.path}"></script>`);
});

test("the page's script is served once per path and kept by the browser", async () => {
  const response = await pageFetch(OWNER_PAGE_SCRIPT_FILE.path, "*/*");

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe(OWNER_PAGE_SCRIPT_FILE.source);
});

test("a script path that is not the current one goes to the relay", async () => {
  const stale = OWNER_PAGE_SCRIPT_FILE.path.replace(/owner-[0-9a-f]+/u, "owner-0000000000000000");
  const response = await pageFetch(stale, "*/*");
  const body = await response.text();

  // No generation is active in this test, so the relay answers its typed 503.
  expect(response.status).toBe(503);
  expect(body).not.toContain("refreshStatus");
});

test("a machine request for GET / still reaches the Supervisor relay", async () => {
  const response = await worker.fetch(pageRequest({ accept: "*/*" }), env);
  const body = await response.text();

  // No generation is active in this test, so the relay reports its typed 503. What matters is
  // that the machine request reached the relay rather than receiving the owner page.
  expect(response.status).toBe(503);
  expect(body).toBe('{"ok":false,"problem":{"code":"no-active-generation"}}');
  expect(body).not.toContain(OWNER_PAGE_IDS.root);
});
