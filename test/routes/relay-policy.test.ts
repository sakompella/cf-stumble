/**
 * Everything that is not the owner page, its script, or the owner API is relayed to the active
 * generation, on the owner's origin and behind the owner's Access session. These tests hold the
 * policy the Worker adds to every relayed response, so that a document the generation serves runs
 * in an opaque origin and cannot use the owner's browser against the owner API.
 */

import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { OWNER_PAGE_SCRIPT_FILE } from "../../src/page/index.js";
import worker from "../../src/worker.js";
import { supervisorNameFor } from "../access-results.js";
import {
  accessAudience,
  accessIssuer,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
} from "../access-tokens.js";

const ORIGIN = "https://cf-stumble.test";

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A request from the verified owner's browser, answered by the Worker. */
async function ownerFetch(path: string, keyName: string): Promise<Response> {
  const key = await signingKey(keyName);

  const token = await signAccessToken(key, {
    iss: accessIssuer,
    aud: [accessAudience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: accessOwnerSubject,
  });

  const ownerEnvironment = {
    ...env,
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: accessAudience,
    CF_ACCESS_PUBLIC_KEYS: JSON.stringify({ keys: [key.publicJwk] }),
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  };

  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      headers: { accept: BROWSER_ACCEPT, cookie: `CF_Authorization=${token}` },
    }),
    ownerEnvironment,
  );
}

/** Make the owner's Supervisor relay answer with `generationResponse`. */
async function generationAnswers(generationResponse: Response): Promise<void> {
  const name = await supervisorNameFor({ identity: accessOwnerSubject, audience: accessAudience });
  const supervisor = env.SUPERVISOR.getByName(name);
  vi.spyOn(env.SUPERVISOR, "getByName").mockReturnValue(supervisor);
  vi.spyOn(supervisor, "fetch").mockResolvedValue(generationResponse);
}

/** A comma separates the policies of one header value; the browser enforces each of them. */
function policies(response: Response): string[] {
  return (response.headers.get("content-security-policy") ?? "")
    .split(",")
    .map((policy) => policy.trim())
    .filter((policy) => policy.length > 0);
}

function directives(policy: string): string[] {
  return policy.split(";").map((directive) => directive.trim().toLowerCase());
}

/** A policy that sandboxes the document into an opaque origin and refuses every framer. */
function isHostRelayPolicy(policy: string): boolean {
  const found = directives(policy);
  const sandbox = found.find((directive) => directive.split(/\s+/u)[0] === "sandbox");

  return (
    sandbox !== undefined &&
    !sandbox.split(/\s+/u).includes("allow-same-origin") &&
    found.includes("frame-ancestors 'none'")
  );
}

test("a relayed HTML document is sandboxed into an opaque origin", async () => {
  await generationAnswers(
    new Response("<!doctype html><script>fetch('/api/status')</script>", {
      status: 201,
      headers: { "content-type": "text/html; charset=utf-8", "x-generation": "kept" },
    }),
  );

  const response = await ownerFetch("/generation/page", "relay-policy-html");

  expect(response.status).toBe(201);
  expect(response.headers.get("x-generation")).toBe("kept");
  expect(await response.text()).toBe("<!doctype html><script>fetch('/api/status')</script>");
  expect(policies(response).filter((policy) => isHostRelayPolicy(policy))).toHaveLength(1);
});

test("a generation's own policy is kept, and cannot lift the host's sandbox", async () => {
  const generationPolicy = "default-src 'self'; sandbox allow-scripts allow-same-origin";

  await generationAnswers(
    new Response("<!doctype html>", {
      headers: {
        "content-type": "text/html",
        "content-security-policy": generationPolicy,
      },
    }),
  );

  const response = await ownerFetch("/generation/app", "relay-policy-merge");
  const found = policies(response);

  expect(found).toContain(generationPolicy);
  expect(found.filter((policy) => isHostRelayPolicy(policy))).toHaveLength(1);
});

test("the owner page and its script keep their own policies", async () => {
  const page = await ownerFetch("/", "relay-policy-page");
  const script = await ownerFetch(OWNER_PAGE_SCRIPT_FILE.path, "relay-policy-script");

  expect(policies(page)).toHaveLength(1);
  expect(policies(page).some((policy) => isHostRelayPolicy(policy))).toBe(false);
  expect(policies(page)[0]).toContain("frame-ancestors 'none'");
  expect(policies(script)).toEqual(["default-src 'none'; frame-ancestors 'none'"]);
});
