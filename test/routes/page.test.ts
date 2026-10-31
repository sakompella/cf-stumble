import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { OWNER_PAGE_SCRIPT_FILE } from "../../src/page/index.js";
import { OWNER_PAGE_IDS } from "../../src/page/element-ids.js";
import { ownerPageResponse } from "../../src/routes/index.js";
import worker from "../../src/worker.js";

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

function pageRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://cf-stumble.test/", { headers });
}

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

test("every GET / is the owner page, whatever it accepts", () => {
  expect(ownerPageResponse(pageRequest({ accept: "*/*" }))?.status).toBe(200);
  expect(ownerPageResponse(pageRequest({ accept: "application/json" }))?.status).toBe(200);
  expect(ownerPageResponse(pageRequest())?.status).toBe(200);
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

test("a path the Worker does not own answers 404", async () => {
  const stale = OWNER_PAGE_SCRIPT_FILE.path.replace(/owner-[0-9a-f]+/u, "owner-0000000000000000");

  for (const path of [stale, "/unknown", "/generations"]) {
    const response = await pageFetch(path, "*/*");

    expect(response.status, path).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: { code: "not-found" } });
  }
});
