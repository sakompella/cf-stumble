import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { OWNER_PAGE_FAVICON, OWNER_PAGE_SCRIPT_FILE } from "../../src/page/index.js";
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

function parsePolicy(header: string | null): Map<string, readonly string[]> {
  return new Map(
    (header ?? "")
      .split(";")
      .map((directive) => directive.trim().split(/\s+/u))
      .map(([name = "", ...sources]) => [name, sources]),
  );
}

test("the page policy admits its own style and scripts, Cloudflare's beacon, and no unsafe code", async () => {
  const response = await pageFetch("/", BROWSER_ACCEPT);
  const policy = parsePolicy(response.headers.get("content-security-policy"));
  const nonce = /^'nonce-([^']+)'$/u.exec(policy.get("style-src")?.[0] ?? "")?.[1];
  const body = await response.text();

  expect(policy.get("default-src")).toEqual(["'none'"]);
  expect(policy.get("connect-src")).toEqual(["'self'"]);
  expect(policy.get("script-src")).toEqual([
    "'self'",
    `'nonce-${nonce ?? ""}'`,
    "https://static.cloudflareinsights.com/beacon.min.js/",
  ]);

  for (const sources of policy.values()) {
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-eval'");
  }

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

test("the favicon is served from the page's own origin, which its image policy admits", async () => {
  const page = await pageFetch("/", BROWSER_ACCEPT);
  const imageSources = parsePolicy(page.headers.get("content-security-policy")).get("img-src");
  const href = /<link rel="icon"[^>]*href="([^"]+)"/u.exec(await page.text())?.[1] ?? "";

  const response = await pageFetch(href, "image/svg+xml,*/*");

  expect(imageSources).toContain("'self'");
  expect(href).toBe(OWNER_PAGE_FAVICON.path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(await response.text()).toBe(OWNER_PAGE_FAVICON.source);
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
