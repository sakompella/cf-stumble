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

function directivesOf(policy: string): ReadonlyMap<string, readonly string[]> {
  return new Map(
    policy
      .split(";")
      .map((directive) => directive.trim().split(/\s+/u))
      .filter(([name]) => name !== undefined && name !== "")
      .map(([name = "", ...sources]) => [name, sources] as const),
  );
}

test("the page policy admits its own style and its same-origin script, and no inline code", async () => {
  const response = await pageFetch("/", BROWSER_ACCEPT);
  const policy = directivesOf(response.headers.get("content-security-policy") ?? "");
  const body = await response.text();
  const [styleSource] = policy.get("style-src") ?? [];
  const nonce = /^'nonce-(.+)'$/u.exec(styleSource ?? "")?.[1];

  expect(policy.get("script-src")).toEqual(["'self'"]);
  expect(policy.get("default-src")).toEqual(["'none'"]);
  expect([...policy.values()].flat().filter((source) => source.includes("unsafe-"))).toEqual([]);
  expect(nonce).toBeDefined();
  expect(body).toContain(`<style nonce="${nonce ?? ""}">`);
  expect(body).toContain(`<script src="${OWNER_PAGE_SCRIPT_FILE.path}"></script>`);
});

test("the page's script is kept by the browser only because its path derives from its content", async () => {
  const response = await pageFetch(OWNER_PAGE_SCRIPT_FILE.path, "*/*");
  const source = await response.text();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));

  const digestHex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  const pathHash = /\/owner-([0-9a-f]+)\.js$/u.exec(OWNER_PAGE_SCRIPT_FILE.path)?.[1] ?? "";

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/javascript");
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(source).toBe(OWNER_PAGE_SCRIPT_FILE.source);
  expect(pathHash).not.toBe("");
  expect(digestHex.startsWith(pathHash)).toBe(true);
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
