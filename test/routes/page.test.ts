/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * The owner page is one plain HTML document behind Cloudflare Access. These tests hold the three
 * properties the rest of version 0 depends on: a browser gets the page, a machine keeps the
 * relayed `GET /` the startup check uses, and no unauthenticated request ever sees the markup.
 * The last test pins the stable identifiers, because browser tests act on them by name.
 */

import { SELF, env } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  commandElementIds,
  ownerPageHtml,
  OWNER_PAGE_ELEMENT_IDS,
  OWNER_PAGE_IDS,
} from "../../src/page/index.js";
import { isOwnerPageRequest, ownerPageResponse } from "../../src/routes/index.js";
import worker from "../../src/worker.js";
import {
  accessAudience,
  accessIssuer,
  signAccessToken,
  signingKey,
  type SigningKey,
} from "../access-tokens.js";

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

function pageRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://cf-stumble.test/", { headers });
}

/** The Worker checks expiry against the real clock, so this token has to be valid right now. */
function ownerToken(key: SigningKey): Promise<string> {
  return signAccessToken(key, {
    iss: accessIssuer,
    aud: [accessAudience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: "owner-1",
  });
}

/** The verified-owner environment. Configured keys keep the whole check local to this process. */
function workerEnvironment(key: SigningKey) {
  return {
    // oxlint-disable-next-line typescript/no-deprecated -- The Worker test environment is supplied by the Cloudflare Vitest plugin.
    ...env,
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: accessAudience,
    CF_ACCESS_PUBLIC_KEYS: JSON.stringify({ keys: [key.publicJwk] }),
  };
}

test("a browser request for GET / receives the owner page", async () => {
  const key = await signingKey("page-browser-key");
  const request = pageRequest({
    accept: BROWSER_ACCEPT,
    cookie: `CF_Authorization=${await ownerToken(key)}`,
  });

  const response = await worker.fetch(request, workerEnvironment(key));
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

test("an unauthenticated browser request never receives the owner page", async () => {
  // oxlint-disable-next-line typescript/no-deprecated
  const response = await SELF.fetch(pageRequest({ accept: BROWSER_ACCEPT }));
  const body = await response.text();

  expect(response.status).toBe(401);
  expect(body).toBe("Unauthorized");
  expect(body).not.toContain(OWNER_PAGE_IDS.root);
});

test("a request with an unusable Access credential never receives the owner page", async () => {
  const configured = await signingKey("page-configured-key");
  const attacker = await signingKey("page-attacker-key");
  const request = pageRequest({
    accept: BROWSER_ACCEPT,
    cookie: `CF_Authorization=${await ownerToken(attacker)}`,
  });

  const response = await worker.fetch(request, workerEnvironment(configured));
  const body = await response.text();

  expect(response.status).toBe(401);
  expect(body).toBe("Unauthorized");
});

test("the page markup carries every stable element id", () => {
  const html = ownerPageHtml("test-nonce");

  for (const id of OWNER_PAGE_ELEMENT_IDS) {
    expect(html, `missing id ${id}`).toContain(`id="${id}"`);
  }
  expect(OWNER_PAGE_ELEMENT_IDS.length).toBe(new Set(OWNER_PAGE_ELEMENT_IDS).size);
});

test("the page builds an executed command row from the documented id pattern", () => {
  const html = ownerPageHtml("test-nonce");
  const first = commandElementIds(0);

  expect(first).toStrictEqual({
    row: "command-0",
    command: "command-0-command",
    exitCode: "command-0-exit-code",
    stdout: "command-0-stdout",
    stderr: "command-0-stderr",
  });
  expect(html).toContain('var base = "command-" + index;');
  expect(html).toContain('base + "-command"');
  expect(html).toContain('base + "-exit-code"');
  expect(html).toContain('base + "-stdout"');
  expect(html).toContain('base + "-stderr"');
});

test("the page uses only the owner JSON endpoints, on this origin", () => {
  const html = ownerPageHtml("test-nonce");

  expect(html).toContain('"/api/status"');
  expect(html).toContain('"/api/recovery/latest"');
  expect(html).toContain('"/api/sessions/"');
  expect(html).toContain('"/api/generations/submit"');
  expect(html).toContain('"/api/generations/" + kind');
  expect(html).not.toMatch(/https?:\/\/(?!cf-stumble\.test)/u);
});

test("the page asks for no credential and stores none", () => {
  const html = ownerPageHtml("test-nonce");

  expect(html).not.toContain("password");
  expect(html).not.toContain("localStorage");
  expect(html).not.toContain("sessionStorage");
  expect(html).not.toContain("document.cookie");
  expect(html).not.toContain("CF_Authorization");
});

test("the page states that recovery repairs nothing by itself", () => {
  const html = ownerPageHtml("test-nonce");

  expect(html).toContain(`id="${OWNER_PAGE_IDS.recoveryNotice}"`);
  expect(html).toContain("does not repair a");
});

test("the page policy allows only inline code from this response and this origin", async () => {
  const key = await signingKey("page-policy-key");
  const request = pageRequest({
    accept: BROWSER_ACCEPT,
    cookie: `CF_Authorization=${await ownerToken(key)}`,
  });

  const response = await worker.fetch(request, workerEnvironment(key));
  const policy = response.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/u.exec(policy)?.[1];
  const body = await response.text();

  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("connect-src 'self'");
  expect(nonce).toBeDefined();
  expect(body).toContain(`<script nonce="${nonce ?? ""}">`);
});

test("a machine request for GET / still reaches the Supervisor relay", async () => {
  const key = await signingKey("page-relay-key");
  const request = pageRequest({
    accept: "*/*",
    cookie: `CF_Authorization=${await ownerToken(key)}`,
  });

  const response = await worker.fetch(request, workerEnvironment(key));
  const body = await response.text();

  // No generation is active in this test, so the relay reports its typed 503. What matters is
  // that the machine request reached the relay rather than receiving the owner page.
  expect(response.status).toBe(503);
  expect(body).toBe('{"ok":false,"problem":{"code":"no-active-generation"}}');
  expect(body).not.toContain(OWNER_PAGE_IDS.root);
});
