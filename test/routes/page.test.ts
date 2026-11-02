import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { OWNER_PAGE_SCRIPT_FILE } from "../../src/page/index.js";
import { OWNER_PAGE_IDS } from "../../src/page/element-ids.js";
import worker from "../../src/worker.js";

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

function pageFetch(path: string, accept: string, method = "GET"): Promise<Response> {
  return worker.fetch(
    new Request(`https://cf-stumble.test${path}`, { method, headers: { accept } }),
    env,
  );
}

test.each([BROWSER_ACCEPT, "*/*", "application/json", ""])(
  "GET / receives the owner page when it accepts %j",
  async (accept) => {
    const response = await pageFetch("/", accept);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("<!doctype html>");
    expect(body).toContain(`id="${OWNER_PAGE_IDS.root}"`);
  },
);

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

test("a path or method the Worker does not own answers 404", async () => {
  const stale = OWNER_PAGE_SCRIPT_FILE.path.replace(/owner-[0-9a-f]+/u, "owner-0000000000000000");

  const requests = [
    ["GET", stale],
    ["GET", "/unknown"],
    ["GET", "/generations"],
    ["POST", "/"],
  ] as const;

  for (const [method, path] of requests) {
    const response = await pageFetch(path, BROWSER_ACCEPT, method);

    expect(response.status, `${method} ${path}`).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: { code: "not-found" } });
  }
});
